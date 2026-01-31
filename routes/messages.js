import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError } from '../utils/envelope.js';
import { toClientTimestamp } from '../utils/dates.js';

const router = express.Router();

/**
 * GET /api/v1/chats/:chatGuid/messages
 * Get messages for a specific chat
 */
router.get('/api/v1/chats/:chatGuid/messages', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const { limit = 50, before } = req.query;
    const offset = req.query?.offset ? parseInt(req.query.offset) : 0;

    const messages = await swiftDaemon.getMessages(
      chatGuid,
      parseInt(limit),
      before ? parseInt(before) : null
    );

    // Transform Swift format → BlueBubbles Message format (dates: Apple ns → ms since epoch)
    const formattedMessages = messages.map(msg => ({
      guid: msg.guid,
      text: msg.text || null,
      chatGuid: chatGuid,
      sender: msg.sender || 'Unknown',
      handleId: msg.handleId || '',
      dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
      dateRead: toClientTimestamp(msg.dateRead) ?? null,
      isFromMe: msg.isFromMe || false,
      attachments: msg.attachments || [],
      subject: msg.subject || null,
      type: msg.type || 'text',
      error: msg.error || null,
      associatedMessageGuid: msg.associatedMessageGuid || null,
      associatedMessageType: msg.associatedMessageType || null
    }));

    logger.debug(`Returning ${formattedMessages.length} messages for chat ${chatGuid}`);
    
    sendSuccess(res, formattedMessages, 'Success', 200, {
      offset,
      limit: parseInt(limit),
      total: formattedMessages.length,
      count: formattedMessages.length
    });
  } catch (error) {
    logger.error(`Get messages error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/chat/:chatGuid/message
 * BlueBubbles-compatible message list
 */
router.get('/api/v1/chat/:chatGuid/message', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const { limit = 50, before } = req.query;
    const offset = req.query?.offset ? parseInt(req.query.offset) : 0;

    const messages = await swiftDaemon.getMessages(
      chatGuid,
      parseInt(limit),
      before ? parseInt(before) : null
    );

    const formattedMessages = messages.map(msg => ({
      guid: msg.guid,
      text: msg.text || null,
      chatGuid: chatGuid,
      sender: msg.sender || 'Unknown',
      handleId: msg.handleId || '',
      dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
      dateRead: toClientTimestamp(msg.dateRead) ?? null,
      isFromMe: msg.isFromMe || false,
      attachments: msg.attachments || [],
      subject: msg.subject || null,
      type: msg.type || 'text',
      error: msg.error || null,
      associatedMessageGuid: msg.associatedMessageGuid || null,
      associatedMessageType: msg.associatedMessageType || null
    }));

    sendSuccess(res, formattedMessages, 'Success', 200, {
      offset,
      limit: parseInt(limit),
      total: formattedMessages.length,
      count: formattedMessages.length
    });
  } catch (error) {
    logger.error(`Get chat messages error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/message/text
 * Send text message
 * Body: { chatGuid, tempGuid, text, method, subject, effectId }
 */
router.post('/api/v1/message/text', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid, tempGuid, text, method = 'apple-script', subject, effectId } = req.body;

    if (!chatGuid || !tempGuid || !text) {
      return sendError(res, 400, 'chatGuid, tempGuid, and text are required', 'Bad Request');
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

    sendSuccess(res, {
      guid: messagePayload.guid,
      chatGuid: chatGuid
    });
  } catch (error) {
    logger.error(`Send message error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/typing-indicator
 * Send typing indicator
 * Body: { chatGuid, isTyping }
 */
router.post('/api/v1/typing-indicator', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid, isTyping } = req.body;

    if (!chatGuid) {
      return sendError(res, 400, 'chatGuid is required', 'Bad Request');
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

    sendSuccess(res, true);
  } catch (error) {
    logger.error(`Typing indicator error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/read_receipt
 * Send read receipt
 * Body: { chatGuid, messageGuids }
 */
router.post('/api/v1/read_receipt', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid, messageGuids } = req.body;

    if (!chatGuid || !messageGuids || !Array.isArray(messageGuids)) {
      return sendError(res, 400, 'chatGuid and messageGuids (array) are required', 'Bad Request');
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

    sendSuccess(res, true);
  } catch (error) {
    logger.error(`Read receipt error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/message/count
 */
router.get('/api/v1/message/count', optionalAuthenticateToken, async (req, res) => {
  sendSuccess(res, { count: 0 });
});

export default router;