import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import logger from './config/logger.js';
import swiftDaemon from './services/swift-daemon.js';
import SocketManager from './services/socket-manager.js';
import registerSocketEvents from './events/socket-events.js';

// Routes
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/server.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io available to routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Routes
app.use(authRoutes);
app.use(serverRoutes);
app.use(chatRoutes);
app.use(messageRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Initialize Socket.IO
const socketManager = new SocketManager(io);

io.on('connection', (socket) => {
  socketManager.handleConnection(socket);
});

// Background polling for Swift daemon updates
let lastCheckTime = Date.now();

const pollSwiftDaemon = async () => {
  try {
    const updates = await swiftDaemon.getUpdates(lastCheckTime);

    const { messages = [], typing = [], receipts = [] } = updates;

    // Emit new messages
    for (const msgData of messages) {
      const chatGuid = msgData.chatGuid;
      if (chatGuid) {
        const messagePayload = {
          guid: msgData.guid,
          text: msgData.text,
          chatGuid: chatGuid,
          sender: msgData.sender || 'Unknown',
          handleId: msgData.handleId || '',
          dateCreated: msgData.dateCreated || Date.now(),
          isFromMe: msgData.isFromMe || false,
          type: msgData.type || 'text',
          attachments: msgData.attachments || []
        };

        // Broadcast to chat room
        socketManager.broadcastToChat(chatGuid, 'message.created', messagePayload);
        logger.info(`Emitted new message to room ${chatGuid}: ${msgData.guid}`);
      }
    }

    // Emit typing indicators
    for (const typingData of typing) {
      const chatGuid = typingData.chatGuid;
      const isTyping = typingData.isTyping;
      const event = isTyping ? 'typing.indicator.started' : 'typing.indicator.stopped';

      if (chatGuid) {
        socketManager.broadcastToChat(chatGuid, event, typingData);
      }
    }

    // Emit read receipts
    for (const receiptData of receipts) {
      const chatGuid = receiptData.chatGuid;
      if (chatGuid) {
        socketManager.broadcastToChat(chatGuid, 'read_receipt', receiptData);
      }
    }

    // Update last check time
    if (messages.length > 0) {
      lastCheckTime = Math.max(
        ...messages.map(msg => msg.dateCreated || 0),
        lastCheckTime
      );
    }
  } catch (error) {
    if (error.message !== 'Request failed with status code 404') {
      logger.error(`Error polling Swift daemon: ${error.message}`);
    }
  }
};

// Start polling every 1 second
setInterval(pollSwiftDaemon, 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 8000;

// Health check Swift daemon before starting
logger.info('Checking Swift daemon connection...');
swiftDaemon.ping()
  .then(connected => {
    if (connected) {
      logger.info('✓ Swift daemon is reachable');
    } else {
      logger.warn('⚠ Swift daemon not reachable (will retry on demand)');
    }

    server.listen(PORT, () => {
      logger.info(`🚀 BlueBubbles Bridge server running on port ${PORT}`);
      logger.info(`📡 Socket.IO endpoint: ws://localhost:${PORT}`);
      logger.info(`📱 Ready for BlueBubbles Android client`);
    });
  })
  .catch(error => {
    logger.error(`Failed to check Swift daemon: ${error.message}`);
    logger.warn('Starting server anyway (Swift daemon may connect later)');
    
    server.listen(PORT, () => {
      logger.info(`🚀 BlueBubbles Bridge server running on port ${PORT}`);
      logger.info(`⚠️  Swift daemon not reachable - check if it's running on port 8081`);
    });
});