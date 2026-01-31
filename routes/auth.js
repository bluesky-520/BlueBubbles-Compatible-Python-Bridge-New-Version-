import express from 'express';
import { generateToken, validatePassword } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError } from '../utils/envelope.js';

const router = express.Router();

/**
 * POST /api/v1/auth
 * BlueBubbles client authentication
 * Request body: { password: string }
 * Response: { access_token: string, token_type: "bearer" }
 */
router.post('/api/v1/auth', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return sendError(res, 400, 'Password is required', 'Bad Request');
    }

    // Validate password
    const isValid = await validatePassword(password);
    
    if (!isValid) {
      return sendError(res, 401, 'Invalid password', 'Unauthorized');
    }

    // Generate JWT token
    const token = generateToken({ sub: 'user' });

    logger.info('User authenticated successfully');
    
    sendSuccess(res, {
      access_token: token,
      token_type: 'bearer'
    });
  } catch (error) {
    logger.error(`Auth error: ${error.message}`);
    sendError(res, 500, 'Authentication failed');
  }
});

export default router;