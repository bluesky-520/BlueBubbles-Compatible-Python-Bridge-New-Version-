import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export const getServerPassword = () =>
  String(
    process.env.SERVER_PASSWORD ||
      process.env.PASSWORD ||
      process.env.SOCKET_PASSWORD ||
      ''
  );

export const readQueryToken = (req) => {
  const token = req.query?.guid ?? req.query?.password ?? req.query?.token;
  if (Array.isArray(token)) return token[0];
  return token ?? null;
};

/**
 * Generate JWT token
 * @param {Object} payload - Token payload
 * @returns {string} JWT token
 */
export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

/**
 * Verify JWT token middleware
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Missing or invalid authorization header' 
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Token expired' 
      });
    }
    
    logger.error(`Auth error: ${error.message}`);
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid token' 
    });
  }
};

/**
 * Optional JWT middleware
 * Allows requests without an Authorization header
 */
export const optionalAuthenticateToken = (req, res, next) => {
  const token = readQueryToken(req);

  if (!token) {
    logger.debug('Client attempted to access API without a token');
    return res.status(401).json({
      success: false,
      error: 'Missing server password!'
    });
  }

  const password = getServerPassword();
  if (!password) {
    logger.error('Server password not configured');
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve password from the server configuration'
    });
  }

  if (String(token).trim() !== String(password).trim()) {
    logger.debug('Client tried to authenticate with incorrect password');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  return next();
};

/**
 * Optional: Basic password validation
 * Replace with your own authentication logic (database, etc.)
 */
export const validatePassword = async (password) => {
  const configured = getServerPassword();
  if (!configured) return false;
  return String(password || '').trim() === String(configured).trim();
};