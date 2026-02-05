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
import { normalizeAttachments } from './utils/attachments.js';

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

const LOG_REQUESTS = String(process.env.LOG_REQUESTS ?? 'true').toLowerCase() === 'true';
const LOG_SOCKET_EVENTS = String(process.env.LOG_SOCKET_EVENTS ?? 'false').toLowerCase() === 'true';

// Request logging (BlueBubbles-like; redacts auth query params)
if (LOG_REQUESTS) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const { method } = req;
    const url = req.originalUrl || req.url;
    const routePath = (url && url.split('?')[0]) || url;
    const urlParams = (() => {
      const q = req.query && Object.keys(req.query).length ? req.query : {};
      const sensitiveKeys = new Set(['guid', 'password', 'token', 'authorization', 'auth']);
      const redacted = {};
      for (const [k, v] of Object.entries(q)) {
        if (sensitiveKeys.has(String(k).toLowerCase())) {
          redacted[k] = '[REDACTED]';
        } else {
          redacted[k] = v;
        }
      }
      return redacted;
    })();
    logger.info(`Incoming: ${method} ${routePath}`);
    logger.debug(`Request to ${routePath} (URL Params: ${JSON.stringify(urlParams)})`);

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const status = res.statusCode;
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      logger.debug(`Request to ${routePath} took ${durationMs} ms`);
      logger.info(`${method} ${url} ${status} ${durationMs}ms - ${ip}`);
    });

    next();
  });
}

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
  // Optional: very verbose socket event logging (off by default; can leak sensitive payloads)
  if (LOG_SOCKET_EVENTS) {
    socket.onAny((eventName, ...args) => {
      const payload = args.length
        ? (typeof args[0] === 'object' ? JSON.stringify(args[0]).slice(0, 200) : String(args[0]).slice(0, 100))
        : '';
      logger.info(`Socket event: ${eventName} ${payload ? ` ${payload}${payload.length >= 200 ? '...' : ''}` : ''}`);
    });
  }
  registerSocketEvents(socket, socketManager);
});

// Background polling for Swift daemon updates
// Keep lastCheckTime in Unix ms to avoid JS precision loss (Apple ns exceeds MAX_SAFE_INTEGER)
let lastCheckTime = Date.now();

// Dedupe: skip re-emitting the same message (belt-and-suspenders for edge cases)
const recentlyEmittedGuids = new Set();
const MAX_EMITTED_CACHE = 1000;

const pollSwiftDaemon = async () => {
  try {
    const updates = await swiftDaemon.getUpdates(lastCheckTime);

    const { messages = [], typing = [], receipts = [] } = updates;

    // Emit new messages
    for (const msgData of messages) {
      const chatGuid = msgData.chatGuid;
      if (!chatGuid) continue;

      // Skip if we already emitted this message (prevents duplicate emissions)
      if (recentlyEmittedGuids.has(msgData.guid)) continue;
      recentlyEmittedGuids.add(msgData.guid);
      if (recentlyEmittedGuids.size > MAX_EMITTED_CACHE) {
        recentlyEmittedGuids.clear();
      }

      const messagePayload = {
        guid: msgData.guid,
        text: msgData.text,
        chatGuid: chatGuid,
        sender: msgData.sender || 'Unknown',
        handleId: (() => {
          const n = Number(msgData.handleId);
          return Number.isFinite(n) ? n : 0;
        })(),
        dateCreated: toClientTimestamp(msgData.dateCreated) ?? Date.now(),
        dateRead: toClientTimestamp(msgData.dateRead) ?? null,
        isFromMe: msgData.isFromMe || false,
        type: msgData.type || 'text',
        subject: msgData.subject || null,
        error: msgData.error != null ? Number(msgData.error) : 0,
        attachments: normalizeAttachments(msgData.attachments || []),
        associatedMessageGuid: msgData.associatedMessageGuid || null,
        associatedMessageType: msgData.associatedMessageType || null
      };

      socketManager.broadcastToChat(chatGuid, 'message.created', messagePayload);
      socketManager.broadcastToChat(chatGuid, 'new-message', messagePayload);
      logger.info(`Emitted new message to room ${chatGuid}: ${msgData.guid}`);
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

    // Update last check time (use Unix ms to avoid precision loss; Apple ns > MAX_SAFE_INTEGER)
    if (messages.length > 0) {
      const maxUnixMs = Math.max(
        ...messages.map(msg => toClientTimestamp(msg.dateCreated) ?? 0),
        lastCheckTime
      );
      lastCheckTime = maxUnixMs;
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
const daemonUrl = swiftDaemon.axios?.defaults?.baseURL || process.env.SWIFT_DAEMON_URL || 'http://localhost:8081';

function logStartupBanner(daemonReachable) {
  const daemonStatus = daemonReachable
    ? `✓ Reachable at ${daemonUrl}`
    : `⚠ Not reachable (will retry on demand) - ${daemonUrl}`;
  logger.info(`
╔═══════════════════════════════════════════════════════════╗
║  BlueBubbles Bridge Started Successfully                   ║
║                                                           ║
║  HTTP Server:    http://localhost:${String(PORT).padEnd(4)}                      ║
║  Socket.IO:      ws://localhost:${String(PORT).padEnd(4)}                      ║
║  Swift Daemon:   ${daemonStatus.padEnd(47)}║
║                                                           ║
║  Ready for BlueBubbles Android client                      ║
╚═══════════════════════════════════════════════════════════╝
`);
}

// Health check Swift daemon, then start server and show status
swiftDaemon.ping()
  .then(connected => {
    server.listen(PORT, () => {
      logStartupBanner(connected);
    });
  })
  .catch(error => {
    logger.debug(`Swift daemon ping failed: ${error.message}`);
    server.listen(PORT, () => {
      logStartupBanner(false);
    });
  });