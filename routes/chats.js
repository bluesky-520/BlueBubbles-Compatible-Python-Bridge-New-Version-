import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError } from '../utils/envelope.js';
import { toClientTimestamp } from '../utils/dates.js';

const router = express.Router();

const parseWithQuery = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
};

const toChatResponse = (chat, options = {}) => {
  const { includeParticipants = false, includeMessages = false, includeLastMessage = true } = options;
  const guid = chat.guid;
  const inferredIdentifier = guid.includes(';')
    ? guid.slice(guid.lastIndexOf(';') + 1)
    : guid;
  const lastMessageText = chat.lastMessageText ?? chat.last_message_text ?? '';
  const rawLastDate = chat.lastMessageDate ?? chat.last_message_date ?? 0;
  const lastMessageDate = toClientTimestamp(rawLastDate) ?? 0;
  const response = {
    originalROWID: chat.originalROWID || 0,
    guid,
    style: chat.style || 0,
    chatIdentifier: inferredIdentifier,
    isArchived: chat.isArchived || false,
    displayName: chat.displayName || '',
    isFiltered: chat.isFiltered || false,
    groupId: chat.groupId || '',
    properties: chat.properties || {},
    lastAddressedHandle: chat.lastAddressedHandle || null
  };

  if (includeLastMessage) {
    response.lastMessage =
      chat.lastMessage ??
      (lastMessageText || lastMessageDate
        ? {
            text: lastMessageText || '',
            dateCreated: lastMessageDate, // ms since epoch (converted from Apple ns if needed)
            guid: null,
            isFromMe: false,
            handle: null
          }
        : null);
  }

  if (includeParticipants) {
    response.participants = Array.isArray(chat.participants) ? chat.participants : [];
  }
  if (includeMessages) {
    response.messages = Array.isArray(chat.messages) ? chat.messages : [];
  }

  return response;
};

/**
 * GET /api/v1/chats
 * Get all conversations
 */
router.get('/api/v1/chats', optionalAuthenticateToken, async (req, res) => {
  try {
    const withQuery = parseWithQuery(req.query?.with);
    const includeParticipants = withQuery.includes('participants');
    const includeLastMessage = withQuery.includes('lastmessage') || withQuery.includes('last-message');
    const includeMessages = withQuery.includes('messages');
    const chats = await swiftDaemon.getChats();
    const formattedChats = chats.map(chat =>
      toChatResponse(chat, {
        includeParticipants,
        includeMessages,
        includeLastMessage
      })
    );

    logger.debug(`Returning ${formattedChats.length} chats`);
    sendSuccess(res, formattedChats);
  } catch (error) {
    logger.error(`Get chats error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/chats/:chatGuid
 * Get specific chat details
 */
router.get('/api/v1/chats/:chatGuid', optionalAuthenticateToken, async (req, res) => {
  try {
    const withQuery = parseWithQuery(req.query?.with);
    const includeParticipants = withQuery.includes('participants');
    const includeLastMessage = withQuery.includes('lastmessage') || withQuery.includes('last-message');
    const includeMessages = withQuery.includes('messages');
    const { chatGuid } = req.params;
    const chats = await swiftDaemon.getChats();
    
    const chat = chats.find(c => c.guid === chatGuid);
    
    if (!chat) {
      return sendError(res, 404, 'Chat not found', 'Not Found');
    }

    sendSuccess(
      res,
      toChatResponse(chat, {
        includeParticipants,
        includeMessages,
        includeLastMessage
      })
    );
  } catch (error) {
    logger.error(`Get chat error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/chat
 * BlueBubbles-compatible chat list
 */
router.get('/api/v1/chat', optionalAuthenticateToken, async (req, res) => {
  try {
    const withQuery = parseWithQuery(req.query?.with);
    const includeParticipants = withQuery.includes('participants');
    const includeLastMessage = withQuery.includes('lastmessage') || withQuery.includes('last-message');
    const includeMessages = withQuery.includes('messages');
    const chats = await swiftDaemon.getChats();
    const formatted = chats.map(chat =>
      toChatResponse(chat, {
        includeParticipants,
        includeMessages,
        includeLastMessage
      })
    );
    sendSuccess(res, formatted);
  } catch (error) {
    logger.error(`Get chat list error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/chat/new
 * Create or find a chat by participant addresses. Must be before /api/v1/chat/:chatGuid so "new" is not matched as chatGuid.
 * Body: { addresses: string[], message?: string }. Returns chat in BlueBubbles envelope.
 */
router.post('/api/v1/chat/new', optionalAuthenticateToken, async (req, res) => {
  try {
    const { addresses = [], message } = req.body || {};
    const list = Array.isArray(addresses) ? addresses.map(a => String(a).trim()).filter(Boolean) : [];
    if (list.length === 0) {
      return sendError(res, 400, 'addresses array is required and cannot be empty', 'Bad Request');
    }
    const firstAddress = list[0];
    const chats = await swiftDaemon.getChats();
    const normalized = firstAddress.replace(/\r/g, '').replace(/\n/g, '');
    const chat = chats.find(c => {
      const guid = (c.guid || '').toLowerCase();
      const addr = normalized.toLowerCase();
      return guid.includes(addr) || guid.endsWith(addr) || guid.endsWith(addr.replace(/^\+/, ''));
    });
    let chatGuid;
    let responseChat;
    if (chat) {
      chatGuid = chat.guid;
      responseChat = toChatResponse(chat, { includeParticipants: true, includeLastMessage: true });
    } else {
      chatGuid = `iMessage;-;${normalized}`;
      responseChat = {
        guid: chatGuid,
        style: list.length > 2 ? 43 : 0,
        chatIdentifier: normalized,
        isArchived: false,
        displayName: '',
        isFiltered: false,
        groupId: list.length > 2 ? chatGuid : '',
        properties: {},
        lastAddressedHandle: null,
        lastMessage: null,
        participants: list.map(addr => ({ address: addr })),
        originalROWID: 0
      };
    }
    if (message && String(message).trim()) {
      try {
        await swiftDaemon.sendMessage(chatGuid, String(message).trim());
      } catch (sendErr) {
        logger.warn(`chat/new: optional initial message send failed: ${sendErr.message}`);
      }
    }
    sendSuccess(res, responseChat);
  } catch (error) {
    logger.error(`Chat new error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/chat/count
 * Must be before /api/v1/chat/:chatGuid so "count" is not matched as chatGuid.
 */
router.get('/api/v1/chat/count', optionalAuthenticateToken, async (req, res) => {
  try {
    const chats = await swiftDaemon.getChats();
    sendSuccess(res, {
      total: chats.length,
      breakdown: { unknown: chats.length }
    });
  } catch (error) {
    logger.error(`Get chat count error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/chat/query
 * Must be before /api/v1/chat/:chatGuid so "query" is not matched as chatGuid.
 */
router.post('/api/v1/chat/query', optionalAuthenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0, query = '' } = req.body || {};
    const chats = await swiftDaemon.getChats();
    const needle = String(query || '').toLowerCase();
    let filtered = chats;
    if (needle) {
      filtered = chats.filter(chat => {
        const display = (chat.displayName || '').toLowerCase();
        const guid = (chat.guid || '').toLowerCase();
        return display.includes(needle) || guid.includes(needle);
      });
    }

    const sliced = filtered.slice(offset, offset + limit).map(chat => toChatResponse(chat));
    sendSuccess(res, sliced, 'Success', 200, {
      count: sliced.length,
      total: filtered.length,
      offset,
      limit
    });
  } catch (error) {
    logger.error(`Chat query error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/chat/:chatGuid
 * BlueBubbles-compatible chat details
 */
router.get('/api/v1/chat/:chatGuid', optionalAuthenticateToken, async (req, res) => {
  try {
    const withQuery = parseWithQuery(req.query?.with);
    const includeParticipants = withQuery.includes('participants');
    const includeLastMessage = withQuery.includes('lastmessage') || withQuery.includes('last-message');
    const includeMessages = withQuery.includes('messages');
    const { chatGuid } = req.params;
    const chats = await swiftDaemon.getChats();
    const chat = chats.find(c => c.guid === chatGuid);

    if (!chat) {
      return sendError(res, 404, 'Chat not found', 'Not Found');
    }

    sendSuccess(
      res,
      toChatResponse(chat, {
        includeParticipants,
        includeMessages,
        includeLastMessage
      })
    );
  } catch (error) {
    logger.error(`Get chat detail error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

export default router;