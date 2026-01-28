import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import { authenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';

const router = express.Router();

/**
 * GET /api/v1/chats
 * Get all conversations
 */
router.get('/api/v1/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await swiftDaemon.getChats();

    // Transform Swift format → BlueBubbles format
    const formattedChats = chats.map(chat => ({
      guid: chat.guid,
      displayName: chat.displayName || 'Unknown',
      lastMessageDate: chat.lastMessageDate || null,
      unreadCount: chat.unreadCount || 0,
      isArchived: chat.isArchived || false,
      properties: chat.properties || {}
    }));

    logger.debug(`Returning ${formattedChats.length} chats`);
    
    res.json({
      success: true,
      data: formattedChats
    });
  } catch (error) {
    logger.error(`Get chats error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/chats/:chatGuid
 * Get specific chat details
 */
router.get('/api/v1/chats/:chatGuid', authenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const chats = await swiftDaemon.getChats();
    
    const chat = chats.find(c => c.guid === chatGuid);
    
    if (!chat) {
      return res.status(404).json({
        success: false,
        error: 'Chat not found'
      });
    }

    res.json({
      success: true,
      data: {
        guid: chat.guid,
        displayName: chat.displayName || 'Unknown',
        lastMessageDate: chat.lastMessageDate || null,
        unreadCount: chat.unreadCount || 0,
        isArchived: chat.isArchived || false
      }
    });
  } catch (error) {
    logger.error(`Get chat error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;