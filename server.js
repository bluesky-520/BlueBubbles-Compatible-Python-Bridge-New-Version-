import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import logger from './config/logger.js';
import swiftDaemon from './services/swift-daemon.js';
import SocketManager from './services/socket-manager.js';
import registerSocketEvents from './events/socket-events.js';
import { createServerErrorResponse } from './utils/socket-response.js';
import { getServerPassword } from './middleware/auth.js';
import { subscribeToDaemonEvents } from './services/daemon-events.js';
import { invalidateContactsCache } from './routes/contacts.js';
import { toClientTimestamp } from './utils/dates.js';

// Routes
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/server.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';
import contactsRoutes from './routes/contacts.js';
import handleRoutes from './routes/handle.js';
import fcmRoutes from './routes/fcm.js';

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
  transports: ['websocket', 'polling'],
  pingInterval: 1000 * 60,
  pingTimeout: 1000 * 60 * 2,
  upgradeTimeout: 1000 * 30,
  maxHttpBufferSize: 1000 * 1000 * 100,
  allowEIO3: true
});

// Middleware
app.use(cors());
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '1024mb' }));

// Request logging
app.use((req, res, next) => {
  const startedAt = Date.now();
  const { method } = req;
  const url = req.originalUrl || req.url;

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    logger.info(`${method} ${url} ${status} ${durationMs}ms - ${ip}`);
  });

  next();
});

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
app.use(contactsRoutes);
app.use(handleRoutes);
app.use(fcmRoutes);

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

// Subscribe to Swift daemon SSE for address book sync (contacts_updated)
subscribeToDaemonEvents({
  onContactsChanged: invalidateContactsCache,
  io
});

io.on('connection', (socket) => {
  const token = socket.handshake.query?.password || socket.handshake.query?.guid || socket.handshake.query?.token;
  const passphrase = getServerPassword();
  const decodedToken = token ? decodeURIComponent(String(token)) : '';

  if (!passphrase) {
    logger.error('Socket authentication failed: server password not configured');
    socket.disconnect();
    return;
  }

  if (!decodedToken || decodedToken.trim() !== passphrase.trim()) {
    logger.info('Closing client connection. Authentication failed.');
    socket.disconnect();
    return;
  }

  socket.use(async (_packet, next) => {
    try {
      await next();
    } catch (error) {
      logger.error(`Socket server error! ${error.message || error}`);
      socket.emit('exception', createServerErrorResponse(error?.message || String(error)));
      next(error);
    }
  });

  socketManager.handleConnection(socket);
  registerSocketEvents(socket, socketManager);
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
          dateCreated: toClientTimestamp(msgData.dateCreated) ?? Date.now(),
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