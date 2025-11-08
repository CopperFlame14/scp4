const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Store active sessions
// Structure: { code: { server: WebSocket, clients: [WebSocket], messages: [] } }
const sessions = new Map();

// Generate random 8-character alphanumeric code
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure code is unique
  if (sessions.has(code)) {
    return generateCode();
  }
  return code;
}

// Log helper
function log(type, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}]`, message, data);
}

// REST API endpoint to create a new server session
app.post('/api/create-session', (req, res) => {
  const code = generateCode();
  sessions.set(code, {
    server: null,
    clients: [],
    messages: [],
    createdAt: Date.now()
  });
  log('SESSION', 'New session created', { code });
  res.json({ code, success: true });
});

// REST API endpoint to check if session exists
app.get('/api/check-session/:code', (req, res) => {
  const { code } = req.params;
  const exists = sessions.has(code.toUpperCase());
  res.json({ exists, code: code.toUpperCase() });
});

// REST API health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  log('CONNECTION', 'New WebSocket connection');
  
  let sessionCode = null;
  let clientRole = null; // 'server' or 'client'
  let clientId = Math.random().toString(36).substr(2, 9);

  // Send connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    clientId
  }));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      log('MESSAGE', 'Received', { type: message.type, clientId });

      switch (message.type) {
        case 'register-server':
          handleRegisterServer(ws, message, clientId);
          break;

        case 'register-client':
          handleRegisterClient(ws, message, clientId);
          break;

        case 'scp-message':
          handleSCPMessage(ws, message, clientId);
          break;

        case 'disconnect':
          handleDisconnect(ws, clientId);
          break;

        default:
          log('WARNING', 'Unknown message type', { type: message.type });
      }
    } catch (error) {
      log('ERROR', 'Message parsing error', { error: error.message });
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    log('DISCONNECT', 'Client disconnected', { clientId, role: clientRole });
    cleanupConnection(ws, sessionCode, clientRole);
  });

  ws.on('error', (error) => {
    log('ERROR', 'WebSocket error', { error: error.message, clientId });
  });

  // Register server
  function handleRegisterServer(ws, message, clientId) {
    const { code } = message;
    const session = sessions.get(code);

    if (!session) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid session code'
      }));
      return;
    }

    if (session.server) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server already registered for this session'
      }));
      return;
    }

    session.server = ws;
    sessionCode = code;
    clientRole = 'server';

    log('REGISTER', 'Server registered', { code, clientId });

    ws.send(JSON.stringify({
      type: 'registered',
      role: 'server',
      code,
      clientId
    }));
  }

  // Register client
  function handleRegisterClient(ws, message, clientId) {
    const { code, username } = message;
    const session = sessions.get(code.toUpperCase());

    if (!session) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid session code'
      }));
      return;
    }

    session.clients.push({ ws, username, clientId });
    sessionCode = code.toUpperCase();
    clientRole = 'client';

    log('REGISTER', 'Client registered', { code: sessionCode, username, clientId });

    // Notify client of successful registration
    ws.send(JSON.stringify({
      type: 'registered',
      role: 'client',
      code: sessionCode,
      username,
      clientId
    }));

    // Notify server that client connected
    if (session.server && session.server.readyState === WebSocket.OPEN) {
      session.server.send(JSON.stringify({
        type: 'client-connected',
        username,
        clientId
      }));
    }

    // Send HELLO message from client to server
    const helloMessage = {
      type: 'scp-message',
      direction: 'client-to-server',
      scpMessage: `SCP/1.1 | HELLO | id=0 | ${username}`,
      from: 'client',
      clientId
    };

    if (session.server && session.server.readyState === WebSocket.OPEN) {
      session.server.send(JSON.stringify(helloMessage));
    }
  }

  // Handle SCP protocol messages
  function handleSCPMessage(ws, message, clientId) {
    const { code, scpMessage, direction, messageId } = message;
    const session = sessions.get(code);

    if (!session) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Session not found'
      }));
      return;
    }

    log('SCP', 'Message forwarding', { 
      direction, 
      messageId,
      code 
    });

    // Store message in session history
    session.messages.push({
      scpMessage,
      direction,
      timestamp: Date.now(),
      messageId
    });

    // Forward message based on direction
    if (direction === 'client-to-server') {
      // Client -> Server
      if (session.server && session.server.readyState === WebSocket.OPEN) {
        session.server.send(JSON.stringify({
          type: 'scp-message',
          scpMessage,
          direction,
          from: 'client',
          messageId,
          clientId
        }));

        // Send ACK back to client after short delay (simulate processing)
        setTimeout(() => {
          const ackMessage = scpMessage.replace(/MSG|HELLO|BYE/, 'ACK').replace(/\|([^|]+)$/, '| MSG_RECEIVED');
          ws.send(JSON.stringify({
            type: 'scp-message',
            scpMessage: ackMessage,
            direction: 'server-to-client',
            from: 'server',
            messageId
          }));
        }, 100);
      }
    } else if (direction === 'server-to-client') {
      // Server -> All Clients
      session.clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'scp-message',
            scpMessage,
            direction,
            from: 'server',
            messageId
          }));

          // Send ACK back to server after short delay
          setTimeout(() => {
            const ackMessage = scpMessage.replace(/MSG|HELLO|BYE/, 'ACK').replace(/\|([^|]+)$/, '| MSG_RECEIVED');
            if (session.server && session.server.readyState === WebSocket.OPEN) {
              session.server.send(JSON.stringify({
                type: 'scp-message',
                scpMessage: ackMessage,
                direction: 'client-to-server',
                from: 'client',
                messageId,
                clientId: client.clientId
              }));
            }
          }, 100);
        }
      });
    }
  }

  // Handle disconnect
  function handleDisconnect(ws, clientId) {
    cleanupConnection(ws, sessionCode, clientRole);
  }

  // Cleanup connection
  function cleanupConnection(ws, code, role) {
    if (!code) return;

    const session = sessions.get(code);
    if (!session) return;

    if (role === 'server') {
      // Notify all clients that server disconnected
      session.clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'server-disconnected'
          }));
        }
      });

      // Clean up session
      sessions.delete(code);
      log('CLEANUP', 'Session removed', { code });
    } else if (role === 'client') {
      // Remove client from session
      session.clients = session.clients.filter(c => c.ws !== ws);

      // Notify server
      if (session.server && session.server.readyState === WebSocket.OPEN) {
        session.server.send(JSON.stringify({
          type: 'client-disconnected',
          clientId
        }));
      }

      log('CLEANUP', 'Client removed from session', { code, clientId });
    }
  }
});

// Cleanup old sessions (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  sessions.forEach((session, code) => {
    if (now - session.createdAt > oneHour) {
      log('CLEANUP', 'Removing old session', { code, age: now - session.createdAt });
      sessions.delete(code);
    }
  });
}, 5 * 60 * 1000); // Check every 5 minutes

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  log('SERVER', `WebSocket server running on port ${PORT}`);
  console.log(`HTTP API: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SERVER', 'SIGTERM received, closing server...');
  server.close(() => {
    log('SERVER', 'Server closed');
    process.exit(0);
  });
});
```

### `backend/.gitignore`
```
node_modules/
.env
*.log
.DS_Store