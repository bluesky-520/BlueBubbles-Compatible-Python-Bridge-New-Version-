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
import { toMessageResponse } from './utils/messages.js';

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

app.get('/health/sse', (req, res) => {
  res.json({
    status: 'ok',
    sseHealthy,
    lastSseEventAt,
    lastSseEventName,
    lastSseConnectAt,
    lastSseDisconnectAt,
    sseConnectCount,
    sseDisconnectCount,
    sseReconnectAttempts,
    lastSseError,
    lastSseErrorAt,
    polling: Boolean(pollTimer),
    pollIntervalMs: POLL_INTERVAL_MS,
    sseIdleTimeoutMs: SSE_IDLE_TIMEOUT_MS,
    sseWatchdogIntervalMs: SSE_WATCHDOG_INTERVAL_MS,
    daemonBaseUrl,
    daemonSseUrl
  });
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

// Dedupe: skip re-emitting the same message (belt-and-suspenders for edge cases)
const recentlyEmittedGuids = new Set();
const MAX_EMITTED_CACHE = 1000;

function shouldEmitMessage(guid) {
  if (!guid) return true;
  if (recentlyEmittedGuids.has(guid)) return false;
  recentlyEmittedGuids.add(guid);
  if (recentlyEmittedGuids.size > MAX_EMITTED_CACHE) {
    recentlyEmittedGuids.clear();
  }
  return true;
}

const POLL_INTERVAL_MS = (() => {
  const raw = process.env.POLL_INTERVAL_MS;
  const n = raw != null ? parseInt(String(raw), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();
const SSE_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.SSE_IDLE_TIMEOUT_MS;
  const n = raw != null ? parseInt(String(raw), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();
const SSE_WATCHDOG_INTERVAL_MS = (() => {
  const raw = process.env.SSE_WATCHDOG_INTERVAL_MS;
  const n = raw != null ? parseInt(String(raw), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();
const LOG_SSE_HEALTH = String(process.env.LOG_SSE_HEALTH ?? 'true').toLowerCase() === 'true';

let pollTimer = null;
let sseHealthy = false;
let lastSseEventAt = 0;
let lastSseEventName = null;
let sseConnectCount = 0;
let sseDisconnectCount = 0;
let sseReconnectAttempts = 0;
let lastSseConnectAt = 0;
let lastSseDisconnectAt = 0;
let lastSseError = null;
let lastSseErrorAt = 0;
const daemonBaseUrl = process.env.SWIFT_DAEMON_URL || 'http://localhost:8081';
const daemonSseUrl = `${daemonBaseUrl.replace(/\/$/, '')}/events`;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollSwiftDaemon, POLL_INTERVAL_MS);
  if (LOG_SSE_HEALTH) logger.info(`Polling enabled (interval=${POLL_INTERVAL_MS}ms)`);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  if (LOG_SSE_HEALTH) logger.info('Polling disabled (SSE healthy)');
}

function setSseHealthy(healthy) {
  if (sseHealthy === healthy) return;
  sseHealthy = healthy;
  if (healthy) {
    if (LOG_SSE_HEALTH) logger.info('SSE connected; marking healthy');
    stopPolling();
  } else {
    if (LOG_SSE_HEALTH) logger.warn('SSE disconnected/unhealthy; enabling polling');
    startPolling();
  }
}

// Subscribe to Swift daemon SSE for address book sync (contacts_updated) and messages
subscribeToDaemonEvents({
  onContactsChanged: invalidateContactsCache,
  onNewMessage: (msgData) => {
    const chatGuid = msgData?.chatGuid || null;
    if (!chatGuid) return;
    const guid = msgData?.guid || null;
    if (!shouldEmitMessage(guid)) return;
    const messagePayload = toMessageResponse(msgData, chatGuid);
    socketManager.broadcastToChat(chatGuid, 'message.created', messagePayload);
    socketManager.broadcastToChat(chatGuid, 'new-message', messagePayload);
    logger.info(`Emitted SSE message to room ${chatGuid}: ${guid || '(no guid)'}`);
  },
  onSseConnected: (info) => {
    sseConnectCount += 1;
    lastSseConnectAt = Date.now();
    if (LOG_SSE_HEALTH) logger.info(`SSE connected (attempt ${info?.attempt ?? sseConnectCount})`);
    setSseHealthy(true);
  },
  onSseDisconnected: (info) => {
    sseDisconnectCount += 1;
    lastSseDisconnectAt = Date.now();
    sseReconnectAttempts += 1;
    if (info?.error?.message) {
      lastSseError = info.error.message;
      lastSseErrorAt = Date.now();
    }
    if (LOG_SSE_HEALTH) logger.warn(`SSE disconnected (${info?.reason || 'unknown'})`);
    setSseHealthy(false);
  },
  onSseEvent: (eventName) => {
    lastSseEventAt = Date.now();
    lastSseEventName = eventName || null;
  },
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

const pollSwiftDaemon = async () => {
  try {
    const updates = await swiftDaemon.getUpdates(lastCheckTime);

    const { messages = [], typing = [], receipts = [] } = updates;

    // Emit new messages
    for (const msgData of messages) {
      const chatGuid = msgData.chatGuid;
      if (!chatGuid) continue;

      const guid = msgData?.guid || null;
      if (!shouldEmitMessage(guid)) continue;

      const messagePayload = toMessageResponse(msgData, chatGuid);

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

// Start polling immediately until SSE is healthy
startPolling();

// Watchdog: if SSE goes quiet, resume polling
setInterval(() => {
  if (!sseHealthy) return;
  if (Date.now() - lastSseEventAt > SSE_IDLE_TIMEOUT_MS) {
    if (LOG_SSE_HEALTH) logger.warn(`SSE idle > ${SSE_IDLE_TIMEOUT_MS}ms; marking unhealthy`);
    setSseHealthy(false);
  }
}, SSE_WATCHDOG_INTERVAL_MS);

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