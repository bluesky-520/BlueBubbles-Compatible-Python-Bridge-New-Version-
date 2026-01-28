import express from 'express';
import logger from '../config/logger.js';

const router = express.Router();

/**
 * GET /api/v1/server/ping
 * Health check endpoint
 */
router.get('/api/v1/server/ping', (req, res) => {
  res.json({
    success: true,
    data: {
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
    }
  });
});

/**
 * GET /api/v1/server/info
 * Server information
 */
router.get('/api/v1/server/info', (req, res) => {
  res.json({
    success: true,
    data: {
      serverName: 'BlueBubbles Bridge',
      version: '1.0.0',
      platform: process.platform,
      nodeVersion: process.version,
      uptime: process.uptime()
    }
  });
});

export default router;