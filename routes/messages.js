import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import { authenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import SocketManager from '../services/socket-manager.js';

const router = express.Router();

/**
 * GET /api/v1/chats/:chatGuid/messages
 * Get messages for a specific chat
 */
router.get('/api/v1/chats/:chatGuid/messages', authenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const { limit = 50, before } = req.query;

    const messages = await swiftDaemon.getMessages(
      chatGuid,
      parseInt(limit),
      before ? parseInt(before) : null
    );

    // Transform Swift format → BlueBubbles Message format
    const formattedMessages = messages.map(msg => ({
      guid: msg.guid,
      text: msg.text || null,
      chatGuid: chatGuid,
      sender: msg.sender || 'Unknown',
      handleId: msg.handleId || '',
      dateCreated: msg.dateCreated || Date.now(),
      dateRead: msg.dateRead || null,
      isFromMe: msg.isFromMe || false,
      attachments: msg.attachments || [],
      subject: msg.subject || null,
      type: msg.type || 'text',
      error: msg.error || null,
      associatedMessageGuid: msg.associatedMessageGuid || null,
      associatedMessageType: msg.associatedMessageType || null
    }));

    logger.debug(`Returning ${formattedMessages.length} messages for chat ${chatGuid}`);
    
    res.json({
      success: true,
      data: formattedMessages
    });
  } catch (error) {
    logger.error(`Get messages error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/message/text
 * Send text message
 * Body: { chatGuid, tempGuid, text, method, subject, effectId }
 */
router.post('/api/v1/message/text', authenticateToken, async (req, res) => {
  try {
    const { chatGuid, tempGuid, text, method = 'apple-script', subject, effectId } = req.body;

    if (!chatGuid || !tempGuid || !text) {
      return res.status(400).json({
        success: false,
        error: 'chatGuid, tempGuid, and text are required'
      });
    }

    // Forward to Swift daemon
    const result = await swiftDaemon.sendMessage(chatGuid, text);

    // Create message payload for Socket.IO event
    const messagePayload = {
      guid: result.guid || tempGuid,
      text: text,
      chatGuid: chatGuid,
      sender: 'Me',
      handleId: 'self',
      dateCreated: Date.now(),
      isFromMe: true,
      type: 'text',
      subject: subject || null
    };

    // Broadcast to all clients in this chat room
    if (req.io) {
      req.io.to(chatGuid).emit('message.created', messagePayload);
    }

    logger.info(`Message sent to chat ${chatGuid}: ${text.substring(0, 30)}...`);

    res.json({
      success: true,
      data: {
        guid: messagePayload.guid,
        chatGuid: chatGuid
      }
    });
  } catch (error) {
    logger.error(`Send message error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/typing-indicator
 * Send typing indicator
 * Body: { chatGuid, isTyping }
 */
router.post('/api/v1/typing-indicator', authenticateToken, async (req, res) => {
  try {
    const { chatGuid, isTyping } = req.body;

    if (!chatGuid) {
      return res.status(400).json({
        success: false,
        error: 'chatGuid is required'
      });
    }

    const eventName = isTyping ? 'typing.indicator.started' : 'typing.indicator.stopped';

    // Emit to chat room
    if (req.io) {
      req.io.to(chatGuid).emit(eventName, {
        chatGuid: chatGuid,
        isTyping: isTyping,
        timestamp: Date.now()
      });
    }

    // Optional: Forward to Swift daemon
    await swiftDaemon.sendTypingIndicator(chatGuid, isTyping).catch(() => {});

    logger.debug(`Typing indicator ${isTyping ? 'started' : 'stopped'} for chat ${chatGuid}`);

    res.json({
      success: true
    });
  } catch (error) {
    logger.error(`Typing indicator error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/read_receipt
 * Send read receipt
 * Body: { chatGuid, messageGuids }
 */
router.post('/api/v1/read_receipt', authenticateToken, async (req, res) => {
  try {
    const { chatGuid, messageGuids } = req.body;

    if (!chatGuid || !messageGuids || !Array.isArray(messageGuids)) {
      return res.status(400).json({
        success: false,
        error: 'chatGuid and messageGuids (array) are required'
      });
    }

    // Emit read receipt event
    if (req.io) {
      req.io.to(chatGuid).emit('read_receipt', {
        chatGuid: chatGuid,
        messageGuids: messageGuids,
        dateRead: Date.now()
      });
    }

    logger.debug(`Read receipt sent for ${messageGuids.length} messages in chat ${chatGuid}`);

    res.json({
      success: true
    });
  } catch (error) {
    logger.error(`Read receipt error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;