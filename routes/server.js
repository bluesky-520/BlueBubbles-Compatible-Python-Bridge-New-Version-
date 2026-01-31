import express from 'express';
import logger from '../config/logger.js';
import { sendSuccess } from '../utils/envelope.js';
import { getServerMetadata } from '../services/server-metadata.js';

const router = express.Router();

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
 */
router.get('/api/v1/server/update/check', (req, res) => {
  sendSuccess(res, {
    updateAvailable: false,
    version: null,
    url: null
  });
});

/**
 * GET /api/v1/server/statistics/totals
 */
router.get('/api/v1/server/statistics/totals', (req, res) => {
  sendSuccess(res, {
    totalChats: 0,
    totalMessages: 0,
    totalAttachments: 0
  });
});

/**
 * GET /api/v1/server/statistics/media
 */
router.get('/api/v1/server/statistics/media', (req, res) => {
  sendSuccess(res, {
    totalAttachments: 0,
    totalMediaSize: 0
  });
});

/**
 * GET /api/v1/icloud/account
 */
router.get('/api/v1/icloud/account', (req, res) => {
  sendSuccess(res, {
    identifier: null,
    displayName: null,
    emails: null,
    phones: null
  });
});

export default router;