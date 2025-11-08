import React, { useState, useEffect, useRef } from 'react';
import { Send, Server, User, Copy, Check, Wifi, WifiOff, RefreshCw, AlertCircle } from 'lucide-react';

// WebSocket URL - Change this to your deployed backend URL
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const SCPLiveImplementation = () => {
  const [mode, setMode] = useState(null); // 'server' or 'client'
  const [serverCode, setServerCode] = useState('');
  const [clientCode, setClientCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [username, setUsername] = useState('');
  const [showUsernamePrompt, setShowUsernamePrompt] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [copied, setCopied] = useState(false);
  const [messageIdCounter, setMessageIdCounter] = useState(0);
  const [error, setError] = useState('');
  const [clientId, setClientId] = useState('');

  const messagesEndRef = useRef(null);
  const ws = useRef(null);
  const reconnectTimeout = useRef(null);

  // Initialize WebSocket connection
  const connectWebSocket = () => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      ws.current = new WebSocket(WS_URL);

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        setError('');
      };

      ws.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('Connection error. Please try again.');
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        if (isConnected) {
          setConnectionStatus('disconnected');
          setError('Connection lost. Attempting to reconnect...');
          
          // Attempt to reconnect after 3 seconds
          reconnectTimeout.current = setTimeout(() => {
            connectWebSocket();
          }, 3000);
        }
      };
    } catch (err) {
      console.error('Error creating WebSocket:', err);
      setError('Failed to connect to server');
    }
  };

  // Handle incoming WebSocket messages
  const handleWebSocketMessage = (data) => {
    console.log('Received:', data);

    switch (data.type) {
      case 'connected':
        setClientId(data.clientId);
        break;

      case 'registered':
        if (data.role === 'server') {
          setIsConnected(true);
          setConnectionStatus('waiting');
          addSystemMessage('✓ Server registered. Waiting for clients...');
        } else if (data.role === 'client') {
          setIsConnected(true);
          setConnectionStatus('connected');
          addSystemMessage('✓ Connected to server successfully!');
        }
        break;

      case 'client-connected':
        addSystemMessage(`✓ Client "${data.username}" connected`);
        setConnectionStatus('connected');
        break;

      case 'client-disconnected':
        addSystemMessage(`⚠ Client disconnected`);
        break;

      case 'server-disconnected':
        addSystemMessage('⚠ Server disconnected');
        setConnectionStatus('disconnected');
        setIsConnected(false);
        break;

      case 'scp-message':
        handleSCPMessage(data);
        break;

      case 'error':
        setError(data.message);
        addSystemMessage(`✗ Error: ${data.message}`);
        break;

      default:
        console.warn('Unknown message type:', data.type);
    }
  };

  // Handle SCP protocol messages
  const handleSCPMessage = (data) => {
    const { scpMessage, direction, from, messageId } = data;

    // Parse SCP message
    const parts = scpMessage.split('|').map(p => p.trim());
    const msgType = parts[1];
    const id = parseInt(parts[2].split('=')[1]);
    const payload = parts[3];

    // Determine if this is our message or incoming
    const isOurMessage = (mode === 'server' && from === 'server') || 
                         (mode === 'client' && from === 'client');

    if (msgType === 'ACK') {
      // Update existing message status
      setMessages(prev => prev.map(msg => 
        msg.id === id ? { ...msg, status: 'acked' } : msg
      ));

      addSystemMessage(`✓ ACK received for message id=${id}`);
    } else {
      // Add new message
      setMessages(prev => [...prev, {
        type: from === 'server' ? 'server' : 'client',
        scpFormat: scpMessage,
        msgType,
        id,
        payload,
        timestamp: new Date().toLocaleTimeString(),
        status: isOurMessage ? 'sending' : 'received'
      }]);
    }
  };

  // Initialize server mode
  const initServer = async () => {
    setConnectionStatus('connecting');
    setError('');

    try {
      // Create session on backend
      const response = await fetch(`${API_URL}/api/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error('Failed to create session');
      }

      const data = await response.json();
      setServerCode(data.code);
      setMode('server');
      
      // Connect WebSocket
      connectWebSocket();

      // Wait for WebSocket to connect, then register
      const checkConnection = setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          clearInterval(checkConnection);
          ws.current.send(JSON.stringify({
            type: 'register-server',
            code: data.code
          }));
          addSystemMessage('Server initialized. Share code with client to connect.');
          addSystemMessage(`Connection Code: ${data.code}`);
        }
      }, 100);

    } catch (err) {
      console.error('Error initializing server:', err);
      setError('Failed to create server session');
      setConnectionStatus('disconnected');
    }
  };

  // Initialize client mode
  const initClient = () => {
    setMode('client');
    setShowUsernamePrompt(true);
    connectWebSocket();
  };

  // Connect client to server
  const connectClient = async () => {
    if (!clientCode.trim() || !username.trim()) {
      setError('Please enter both username and connection code');
      return;
    }

    setConnectionStatus('connecting');
    setError('');

    try {
      // Check if session exists
      const response = await fetch(`${API_URL}/api/check-session/${clientCode.toUpperCase()}`);
      const data = await response.json();

      if (!data.exists) {
        setError('Invalid connection code');
        setConnectionStatus('disconnected');
        return;
      }

      addSystemMessage(`Connecting to server with code: ${clientCode.toUpperCase()}...`);

      // Wait for WebSocket connection
      const checkConnection = setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          clearInterval(checkConnection);
          ws.current.send(JSON.stringify({
            type: 'register-client',
            code: clientCode.toUpperCase(),
            username
          }));
        }
      }, 100);

    } catch (err) {
      console.error('Error connecting:', err);
      setError('Failed to connect to server');
      setConnectionStatus('disconnected');
    }
  };

  // Add system message
  const addSystemMessage = (text) => {
    setMessages(prev => [...prev, {
      type: 'system',
      text,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  // Send SCP formatted message
  const sendSCPMessage = (msgType, payload) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      setError('Not connected to server');
      return;
    }

    const id = messageIdCounter;
    setMessageIdCounter(prev => prev + 1);
    
    const scpMsg = `SCP/1.1 | ${msgType} | id=${id} | ${payload}`;
    const direction = mode === 'server' ? 'server-to-client' : 'client-to-server';

    // Add to UI immediately
    setMessages(prev => [...prev, {
      type: mode === 'server' ? 'server' : 'client',
      scpFormat: scpMsg,
      msgType,
      id,
      payload,
      timestamp: new Date().toLocaleTimeString(),
      status: 'sending'
    }]);

    // Send via WebSocket
    ws.current.send(JSON.stringify({
      type: 'scp-message',
      code: mode === 'server' ? serverCode : clientCode.toUpperCase(),
      scpMessage: scpMsg,
      direction,
      messageId: id
    }));
  };

  // Handle sending message
  const handleSendMessage = () => {
    if (!inputMessage.trim()) return;
    sendSCPMessage('MSG', inputMessage);
    setInputMessage('');
  };

  // Copy code to clipboard
  const copyCode = () => {
    navigator.clipboard.writeText(serverCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle Enter key
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showUsernamePrompt) {
        if (username.trim() && clientCode.length === 8) {
          setShowUsernamePrompt(false);
          connectClient();
        }
      } else {
        handleSendMessage();
      }
    }
  };

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  // Reset function
  const reset = () => {
    if (ws.current) {
      ws.current.close();
    }
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
    }
    setMode(null);
    setServerCode('');
    setClientCode('');
    setIsConnected(false);
    setMessages([]);
    setInputMessage('');
    setUsername('');
    setShowUsernamePrompt(false);
    setConnectionStatus('disconnected');
    setMessageIdCounter(0);
    setError('');
  };

  // Mode selection screen
  if (!mode) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <div className="max-w-4xl w-full">
          <div className="text-center mb-12">
            <h1 className="text-5xl font-bold text-teal-400 mb-4">🔄 Two-Way SCP Live Demo</h1>
            <p className="text-slate-400 text-lg">Real Bidirectional Communication with WebSockets</p>
            <p className="text-slate-500 text-sm mt-2">Works across devices and browser tabs!</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-center gap-3">
              <AlertCircle className="text-red-400" size={20} />
              <p className="text-red-300">{error}</p>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {/* Server Card */}
            <div 
              onClick={initServer}
              className="bg-slate-800 border-2 border-teal-500/30 rounded-2xl p-8 cursor-pointer hover:border-teal-500 hover:shadow-2xl hover:shadow-teal-500/20 transition-all duration-300 group"
            >
              <div className="flex justify-center mb-6">
                <div className="w-20 h-20 bg-gradient-to-br from-teal-500 to-teal-600 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Server size={40} className="text-slate-900" />
                </div>
              </div>
              <h2 className="text-2xl font-bold text-teal-400 text-center mb-3">Start as Server</h2>
              <p className="text-slate-400 text-center mb-4">
                Generate a connection code and wait for clients to connect
              </p>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>✓ Generate unique connection code</li>
                <li>✓ Accept client connections</li>
                <li>✓ Real WebSocket communication</li>
                <li>✓ Works across devices</li>
              </ul>
            </div>

            {/* Client Card */}
            <div 
              onClick={initClient}
              className="bg-slate-800 border-2 border-emerald-500/30 rounded-2xl p-8 cursor-pointer hover:border-emerald-500 hover:shadow-2xl hover:shadow-emerald-500/20 transition-all duration-300 group"
            >
              <div className="flex justify-center mb-6">
                <div className="w-20 h-20 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                  <User size={40} className="text-slate-900" />
                </div>
              </div>
              <h2 className="text-2xl font-bold text-emerald-400 text-center mb-3">Start as Client</h2>
              <p className="text-slate-400 text-center mb-4">
                Enter a connection code to join a server
              </p>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>✓ Connect with server code</li>
                <li>✓ Set your username</li>
                <li>✓ Real-time SCP protocol</li>
                <li>✓ Full-duplex communication</li>
              </ul>
            </div>
          </div>

          <div className="mt-12 text-center">
            <p className="text-slate-500 text-sm">
              💡 Open this page on different devices or tabs to test real client-server communication
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Username prompt for client
  if (showUsernamePrompt) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-800 border-2 border-emerald-500/30 rounded-2xl p-8">
          <h2 className="text-3xl font-bold text-emerald-400 mb-6 text-center">Client Setup</h2>
          
          {error && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-500/50 rounded-lg flex items-center gap-2">
              <AlertCircle className="text-red-400" size={18} />
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-slate-400 mb-2 text-sm font-medium">Your Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter your name..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py
                py-3 text-slate-200 focus:outline-none focus:border-emerald-500 transition"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-2 text-sm font-medium">Connection Code</label>
              <input
                type="text"
                value={clientCode}
                onChange={(e) => setClientCode(e.target.value.toUpperCase())}
                onKeyPress={handleKeyPress}
                placeholder="Enter 8-character code..."
                maxLength={8}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 font-mono text-lg tracking-wider focus:outline-none focus:border-emerald-500 transition"
              />
            </div>

            <button
              onClick={() => {
                setShowUsernamePrompt(false);
                connectClient();
              }}
              disabled={!username.trim() || clientCode.length !== 8 || connectionStatus === 'connecting'}
              className="w-full bg-gradient-to-r from-emerald-500 to-emerald-600 text-slate-900 font-bold py-3 rounded-lg hover:from-emerald-600 hover:to-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect to Server'}
            </button>

            <button
              onClick={reset}
              className="w-full bg-slate-700 text-slate-300 font-medium py-3 rounded-lg hover:bg-slate-600 transition"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main chat interface
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="bg-slate-800 border-2 border-slate-700 rounded-2xl p-6 mb-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                mode === 'server' ? 'bg-gradient-to-br from-teal-500 to-teal-600' : 'bg-gradient-to-br from-emerald-500 to-emerald-600'
              }`}>
                {mode === 'server' ? <Server size={24} className="text-slate-900" /> : <User size={24} className="text-slate-900" />}
              </div>
              <div>
                <h2 className="text-2xl font-bold text-slate-200">
                  {mode === 'server' ? 'Server Mode' : 'Client Mode'}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  {connectionStatus === 'connected' ? (
                    <>
                      <Wifi size={16} className="text-emerald-400" />
                      <span className="text-emerald-400 text-sm font-medium">Connected</span>
                    </>
                  ) : connectionStatus === 'connecting' ? (
                    <>
                      <RefreshCw size={16} className="text-yellow-400 animate-spin" />
                      <span className="text-yellow-400 text-sm font-medium">Connecting...</span>
                    </>
                  ) : connectionStatus === 'waiting' ? (
                    <>
                      <Wifi size={16} className="text-yellow-400" />
                      <span className="text-yellow-400 text-sm font-medium">Waiting for client...</span>
                    </>
                  ) : (
                    <>
                      <WifiOff size={16} className="text-slate-500" />
                      <span className="text-slate-500 text-sm font-medium">Disconnected</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {mode === 'server' && serverCode && (
              <div className="flex items-center gap-3 bg-slate-900 px-6 py-3 rounded-lg border border-teal-500/30">
                <div>
                  <p className="text-slate-500 text-xs font-medium">Connection Code</p>
                  <p className="text-teal-400 text-2xl font-mono font-bold tracking-wider">{serverCode}</p>
                </div>
                <button
                  onClick={copyCode}
                  className="p-2 hover:bg-slate-800 rounded-lg transition"
                  title="Copy code"
                >
                  {copied ? <Check size={20} className="text-emerald-400" /> : <Copy size={20} className="text-slate-400" />}
                </button>
              </div>
            )}

            <button
              onClick={reset}
              className="px-4 py-2 bg-slate-700 text-slate-300 rounded-lg hover:bg-slate-600 transition font-medium"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-4 p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-center gap-3">
            <AlertCircle className="text-red-400" size={20} />
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {/* Messages Area */}
        <div className="bg-slate-800 border-2 border-slate-700 rounded-2xl p-6 mb-4" style={{ height: '500px', display: 'flex', flexDirection: 'column' }}>
          <div className="flex-1 overflow-y-auto space-y-3 pr-2">
            {messages.map((msg, idx) => (
              <div key={idx} className={`${
                msg.type === 'system' ? 'text-center' :
                msg.type === 'server' ? 'text-left' : 'text-right'
              }`}>
                {msg.type === 'system' ? (
                  <div className="inline-block bg-slate-900 border border-slate-700 rounded-lg px-4 py-2">
                    <p className="text-slate-400 text-sm">{msg.text}</p>
                    <p className="text-slate-600 text-xs mt-1">{msg.timestamp}</p>
                  </div>
                ) : (
                  <div className={`inline-block max-w-[80%] ${
                    msg.type === 'server' ? 'bg-teal-900/30 border-teal-500/30' : 'bg-emerald-900/30 border-emerald-500/30'
                  } border rounded-lg p-4`}>
                    <div className="font-mono text-xs text-slate-500 mb-2 break-all">
                      {msg.scpFormat}
                    </div>
                    {msg.msgType === 'MSG' && (
                      <p className={`text-sm ${msg.type === 'server' ? 'text-teal-300' : 'text-emerald-300'}`}>
                        {msg.payload}
                      </p>
                    )}
                    <div className="flex items-center justify-between mt-2 text-xs">
                      <span className="text-slate-500">{msg.timestamp}</span>
                      {msg.status === 'acked' && (
                        <span className="text-emerald-400">✓ Acknowledged</span>
                      )}
                      {msg.status === 'sending' && (
                        <span className="text-yellow-400">Sending...</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area */}
        {isConnected && (
          <div className="bg-slate-800 border-2 border-slate-700 rounded-2xl p-4">
            <div className="flex gap-3">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={`Type a message ${mode === 'server' ? 'to client' : 'to server'}...`}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:border-teal-500 transition"
              />
              <button
                onClick={handleSendMessage}
                disabled={!inputMessage.trim()}
                className={`px-6 py-3 rounded-lg font-bold flex items-center gap-2 transition ${
                  mode === 'server'
                    ? 'bg-gradient-to-r from-teal-500 to-teal-600 hover:from-teal-600 hover:to-teal-700'
                    : 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700'
                } text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Send size={20} />
                Send
              </button>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="mt-4 text-center">
          <p className="text-slate-500 text-sm">
            {mode === 'server' 
              ? '💡 Share the connection code with a client to establish communication'
              : isConnected
                ? '💡 You are connected! Send messages using the SCP protocol'
                : '💡 Enter a valid connection code to connect to a server'
            }
          </p>
        </div>
      </div>
    </div>
  );
};

export default SCPLiveImplementation;