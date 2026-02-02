import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import sendCache from '../services/send-cache.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError } from '../utils/envelope.js';
import { toClientTimestamp } from '../utils/dates.js';

const router = express.Router();

/**
 * Build BlueBubbles-style message payload (matches MessageSerializer / message.match).
 * Used for send success and error responses.
 */
function toMessagePayload(msg, chatGuid, opts = {}) {
  const { tempGuid, errorCode = 0 } = opts;
  const payload = {
    guid: msg.guid || null,
    text: msg.text ?? '',
    chatGuid: chatGuid || msg.chatGuid || null,
    handleId: msg.handleId ?? 0,
    dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
    dateRead: toClientTimestamp(msg.dateRead) ?? null,
    isFromMe: msg.isFromMe !== false,
    type: msg.type || 'text',
    subject: msg.subject || null,
    error: errorCode,
    attachments: msg.attachments || [],
    associatedMessageGuid: msg.associatedMessageGuid || null,
    associatedMessageType: msg.associatedMessageType || null
  };
  if (tempGuid) payload.tempGuid = tempGuid;
  return payload;
}

/**
 * GET /api/v1/chat/:chatGuid/message
 * BlueBubbles-compatible message list (matches official server: query params, 404 when chat missing, metadata).
 * Query: limit (1-1000, default 50), offset (row offset, default 0), before, after (unix ms), sort (ASC|DESC).
 */
router.get('/api/v1/chat/:chatGuid/message', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const limitRaw = req.query?.limit != null ? parseInt(req.query.limit, 10) : 50;
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 1000);
    const offset = req.query?.offset != null ? Math.max(0, parseInt(req.query.offset, 10) || 0) : 0;
    const before = req.query?.before != null ? parseInt(req.query.before, 10) : null;
    const after = req.query?.after != null ? parseInt(req.query.after, 10) : null;
    const sort = (req.query?.sort === 'ASC' || req.query?.sort === 'DESC') ? req.query.sort : null;

    // Official server: verify chat exists first → 404 "Chat does not exist!"
    const chat = await swiftDaemon.getChat(chatGuid);
    if (chat == null) {
      return sendError(res, 404, 'Chat does not exist!', 'Not Found');
    }

    // Daemon only supports limit + before; fetch enough for offset (request limit + offset, then slice)
    const fetchLimit = Math.min(limit + offset, 1000);
    const messages = await swiftDaemon.getMessages(
      chatGuid,
      fetchLimit,
      before
    );

    // Optional client-side filter by after (daemon has no after param)
    let filtered = messages;
    if (after != null && after > 0) {
      filtered = messages.filter(msg => (toClientTimestamp(msg.dateCreated) ?? 0) > after);
    }
    if (sort === 'ASC') {
      filtered = [...filtered].reverse();
    }
    // Apply offset (daemon has no offset param)
    const sliced = offset > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(0, limit);

    const formattedMessages = sliced.map(msg => ({
      guid: msg.guid,
      text: msg.text || null,
      chatGuid: chatGuid,
      sender: msg.sender || 'Unknown',
      handleId: msg.handleId ?? '',
      handle: msg.handleId != null ? { address: msg.sender || msg.handleId, id: msg.handleId } : null,
      dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
      dateRead: toClientTimestamp(msg.dateRead) ?? null,
      isFromMe: msg.isFromMe !== false,
      attachments: msg.attachments || [],
      subject: msg.subject || null,
      type: msg.type || 'text',
      error: msg.error != null ? Number(msg.error) : 0,
      associatedMessageGuid: msg.associatedMessageGuid || null,
      associatedMessageType: msg.associatedMessageType || null
    }));

    const count = formattedMessages.length;
    const total = count;
    sendSuccess(res, formattedMessages, 'Success', 200, {
      offset,
      limit,
      total,
      count
    });
  } catch (error) {
    logger.error(`Get chat messages error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/message/text
 * Send text message (processing matches bluebubbles-server: sendCache, tempGuid, message payload, error shape).
 * Body: { chatGuid, text } required; { tempGuid, method, subject, effectId } optional.
 */
router.post('/api/v1/message/text', optionalAuthenticateToken, async (req, res) => {
  const tempGuidOrFallback = req.body?.tempGuid || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const { chatGuid: bodyChatGuid, tempGuid, text, method = 'apple-script', subject, effectId, attachmentPaths } = req.body || {};
    // Allow chat identifier from query ?guid=... for client compatibility (e.g. BlueBubbles app)
    const chatGuid = bodyChatGuid ?? req.query?.guid ?? null;

    const textStr = text != null ? String(text) : '';
    const paths = Array.isArray(attachmentPaths) ? attachmentPaths.filter(Boolean) : [];
    logger.info(`POST /api/v1/message/text chatGuid=${chatGuid ?? '(missing)'} textLen=${textStr.length} attachments=${paths.length} queryGuid=${req.query?.guid ?? '(none)'}`);

    if (!chatGuid || (textStr.trim() === '' && paths.length === 0)) {
      return sendError(res, 400, 'chatGuid and (non-empty text or attachmentPaths) are required', 'Bad Request');
    }

    // Match bluebubbles-server: reject if message already queued (tempGuid in sendCache)
    if (sendCache.find(tempGuidOrFallback)) {
      return sendError(
        res,
        400,
        `Message is already queued to be sent (Temp GUID: ${tempGuidOrFallback})!`,
        'Bad Request'
      );
    }

    sendCache.add(tempGuidOrFallback);

    try {
      const result = await swiftDaemon.sendMessage(chatGuid, textStr, {
        attachmentPaths: paths.length ? paths : undefined,
        tempGuid: tempGuidOrFallback
      });

      const sentMessage = {
        guid: (result && result.guid) ? result.guid : tempGuidOrFallback,
        text: textStr,
        chatGuid,
        dateCreated: result?.dateCreated ?? Date.now(),
        isFromMe: true,
        type: 'text',
        subject: subject || null,
        error: 0
      };

      const data = toMessagePayload(sentMessage, chatGuid, { tempGuid: tempGuidOrFallback });

      sendCache.remove(tempGuidOrFallback);

      if (req.io) {
        req.io.to(chatGuid).emit('message.created', data);
      }

      logger.info(`Message sent to chat ${chatGuid}: ${textStr.substring(0, 30)}...`);

      return sendSuccess(res, data, 'Message sent!', 200);
    } catch (sendErr) {
      sendCache.remove(tempGuidOrFallback);
      const errorMessage = sendErr?.message ?? 'Failed to send message';
      logger.error(`Send message error: ${errorMessage}`);

      // Match bluebubbles-server IMessageError: return message data + error for client to show error code
      const errorData = toMessagePayload(
        {
          guid: null,
          text: textStr,
          chatGuid,
          dateCreated: Date.now(),
          isFromMe: true,
          type: 'text',
          error: 4
        },
        chatGuid,
        { tempGuid: tempGuidOrFallback, errorCode: 4 }
      );

      return res.status(500).json({
        status: 500,
        message: 'Message Send Error',
        error: 'Failed to send message! See attached message error code.',
        data: errorData
      });
    }
  } catch (error) {
    sendCache.remove(tempGuidOrFallback);
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

    const dateRead = Date.now();
    const payload = { chatGuid, messageGuids, dateRead };

    if (req.io) {
      req.io.to(chatGuid).emit('read_receipt', payload);
    }

    await swiftDaemon.sendReadReceipt(chatGuid, messageGuids).catch(() => {});

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

/**
 * GET /api/v1/attachment/:guid
 * Proxy attachment file from Swift daemon.
 */
router.get('/api/v1/attachment/:guid', optionalAuthenticateToken, async (req, res) => {
  try {
    const { guid } = req.params;
    if (!guid) return sendError(res, 400, 'Attachment GUID required', 'Bad Request');
    const response = await swiftDaemon.getAttachmentStream(guid);
    const contentType = response.headers['content-type'];
    const contentDisposition = response.headers['content-disposition'];
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    response.data.pipe(res);
  } catch (error) {
    if (error?.response?.status === 404) {
      return res.status(404).json({ status: 404, message: 'Attachment not found' });
    }
    logger.error(`Attachment proxy error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

export default router;