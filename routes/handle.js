import express from 'express';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import { sendSuccess } from '../utils/envelope.js';

const router = express.Router();

/**
 * GET /api/v1/handle/availability/imessage
 * Check if a handle (phone/email) is available on iMessage. Clients expect this; return stub to avoid 404.
 * Query: address (required), guid (optional). Same shape as BlueBubbles: { data: { online, available } }
 */
router.get('/api/v1/handle/availability/imessage', optionalAuthenticateToken, (req, res) => {
  const address = (req.query?.address ?? '').toString().trim();
  if (!address) {
    return res.status(400).json({ status: 400, message: 'address query parameter is required', error: 'address missing' });
  }
  const cleanAddress = address
    .replace(/\r/g, '')
    .replace(/\n/g, '');
  sendSuccess(res, { online: true, available: true });
});

/**
 * GET /api/v1/handle/:address/focus
 * Returns focus status for a handle (address). Clients expect this; return stub to avoid 404.
 * Same shape as BlueBubbles NativeBackend: { data: { address, focused } }
 */
router.get('/api/v1/handle/:address/focus', optionalAuthenticateToken, (req, res) => {
  const address = req.params?.address?.trim();
  if (!address) {
    return res.status(400).json({ status: 400, message: 'address missing', error: 'address missing' });
  }
  const cleanAddress = address
    .replace(/\r/g, '')
    .replace(/\n/g, '');
  sendSuccess(res, { address: cleanAddress, focused: true });
});

export default router;
