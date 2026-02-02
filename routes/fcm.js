import express from 'express';
import logger from '../config/logger.js';
import { sendSuccess } from '../utils/envelope.js';
import { getFcmClientConfig } from '../services/fcm-config.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/v1/fcm/client
 * Returns FCM client config (google-services.json)
 */
router.get('/api/v1/fcm/client', optionalAuthenticateToken, (req, res) => {
  const config = getFcmClientConfig();
  sendSuccess(res, config);
});

/**
 * POST /api/v1/fcm/device
 * Registers a device for push notifications
 * Body: { name, identifier }
 */
router.post('/api/v1/fcm/device', optionalAuthenticateToken, (req, res) => {
  const { name, identifier } = req.body || {};
  logger.info(`FCM device registered: ${name || 'unknown'} (${identifier || 'n/a'})`);
  sendSuccess(res, { message: 'Successfully added device!' });
});

export default router;
