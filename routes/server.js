import express from 'express';
import logger from '../config/logger.js';
import { sendSuccess } from '../utils/envelope.js';
import { getServerMetadata } from '../services/server-metadata.js';
import swiftDaemon from '../services/swift-daemon.js';

const router = express.Router();
const SERVER_VERSION = process.env.SERVER_VERSION || '1.0.0';

/**
 * GET /api/v1/server/ping
 * Health check endpoint
 */
router.get('/api/v1/server/ping', (req, res) => {
  sendSuccess(res, {
    version: '1.0.0',
    name: 'BlueBubbles Bridge (Node.js)',
    features: {
      privateApi: false,
      typingIndicators: true,
      readReceipts: true,
      reactions: false,
      groupChat: true,
      attachments: true
    },
    timestamp: Date.now()
  });
});

/**
 * GET /api/v1/server/info
 * Server information
 */
router.get('/api/v1/server/info', (req, res) => {
  getServerMetadata()
    .then(meta => sendSuccess(res, meta))
    .catch(error => {
      logger.error(`Server info error: ${error.message}`);
      sendSuccess(res, {
        os_version: `${process.platform} ${process.release?.name || ''}`.trim(),
        server_version: process.env.SERVER_VERSION || '1.0.0',
        private_api: false,
        proxy_service: process.env.PROXY_SERVICE || 'zrok',
        helper_connected: false,
        detected_icloud: '',
        detected_imessage: '',
        macos_time_sync: null,
        local_ipv4s: [],
        local_ipv6s: []
      });
    });
});

/**
 * GET /api/v1/ping
 */
router.get('/api/v1/ping', (req, res) => {
  sendSuccess(res, 'pong');
});

/**
 * GET /api/v1/server/permissions
 */
router.get('/api/v1/server/permissions', (req, res) => {
  sendSuccess(res, {
    contacts: 'notDetermined',
    accessibility: 'notDetermined',
    automation: 'notDetermined',
    messages_automation: 'notDetermined',
    helper_installed: false,
    helper_running: false
  });
});

/**
 * POST /api/v1/server/permissions/request
 */
router.post('/api/v1/server/permissions/request', (req, res) => {
  logger.info('Permissions request received');
  sendSuccess(res, {
    contacts: 'notDetermined',
    accessibility: 'notDetermined',
    automation: 'notDetermined',
    messages_automation: 'notDetermined',
    helper_installed: false,
    helper_running: false
  });
});

/**
 * GET /api/v1/server/update/check
 * Matches official BlueBubbles format: { available, current, metadata }
 */
router.get('/api/v1/server/update/check', (req, res) => {
  sendSuccess(res, {
    available: false,
    current: SERVER_VERSION,
    metadata: null
  });
});

/**
 * GET /api/v1/server/statistics/totals
 * Matches official format: { handles, messages, chats, attachments }
 * Fetches from daemon when available.
 */
router.get('/api/v1/server/statistics/totals', async (req, res) => {
  try {
    const only = req.query.only;
    const opts = only ? { only: Array.isArray(only) ? only.join(',') : String(only) } : {};
    const data = await swiftDaemon.getStatisticsTotals(opts);
    sendSuccess(res, data);
  } catch (error) {
    logger.warn(`Statistics totals fallback (daemon unavailable): ${error.message}`);
    sendSuccess(res, {
      handles: 0,
      messages: 0,
      chats: 0,
      attachments: 0
    });
  }
});

/**
 * GET /api/v1/server/statistics/media
 * Matches official format: { images, videos, locations }
 * Fetches from daemon when available.
 */
router.get('/api/v1/server/statistics/media', async (req, res) => {
  try {
    const only = req.query.only;
    const opts = only ? { only: Array.isArray(only) ? only.join(',') : String(only) } : {};
    const data = await swiftDaemon.getStatisticsMedia(opts);
    sendSuccess(res, data);
  } catch (error) {
    logger.warn(`Statistics media fallback (daemon unavailable): ${error.message}`);
    sendSuccess(res, {
      images: 0,
      videos: 0,
      locations: 0
    });
  }
});

/**
 * GET /api/v1/icloud/account
 * Matches official format: { identifier, displayName, emails, phones }
 * Without Private API, returns nulls (daemon has no iCloud access).
 */
router.get('/api/v1/icloud/account', async (req, res) => {
  const meta = await getServerMetadata().catch(() => ({}));
  const detectedIcloud = meta.detected_icloud || process.env.DETECTED_ICLOUD || '';
  sendSuccess(res, {
    identifier: detectedIcloud || null,
    displayName: null,
    emails: detectedIcloud ? [detectedIcloud] : null,
    phones: null
  });
});

export default router;