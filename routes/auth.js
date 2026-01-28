import express from 'express';
import { generateToken, validatePassword } from '../middleware/auth.js';
import logger from '../config/logger.js';

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
      return res.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }

    // Validate password
    const isValid = await validatePassword(password);
    
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }

    // Generate JWT token
    const token = generateToken({ sub: 'user' });

    logger.info('User authenticated successfully');
    
    res.json({
      success: true,
      data: {
        access_token: token,
        token_type: 'bearer'
      }
    });
  } catch (error) {
    logger.error(`Auth error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
});

export default router;