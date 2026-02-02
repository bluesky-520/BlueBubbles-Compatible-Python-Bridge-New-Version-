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

/** Extract address part from chat GUID (e.g. "iMessage;-;+123" -> "+123"). */
const addressFromGuid = (guid) => {
  if (!guid) return '';
  const idx = guid.indexOf(';-;');
  return idx >= 0 ? guid.slice(idx + 3).trim() : guid;
};

/** Find chat by exact guid or by matching address (handles + prefix mismatch). */
const findChatByGuid = (chats, chatGuid) => {
  let chat = chats.find(c => c.guid === chatGuid);
  if (chat) return chat;
  const wantAddr = addressFromGuid(chatGuid);
  if (!wantAddr) return null;
  const wantNorm = wantAddr.replace(/^\+/, '').toLowerCase();
  return chats.find(c => {
    const addr = addressFromGuid(c.guid || '');
    if (!addr) return false;
    const norm = addr.replace(/^\+/, '').toLowerCase();
    return norm === wantNorm || addr.toLowerCase() === wantAddr.toLowerCase();
  }) || null;
};

/** Clean identifier for display (never expose internal ";-;" in UI). */
const toDisplayIdentifier = (guid) => {
  if (!guid) return '';
  const addr = addressFromGuid(guid);
  if (addr) return addr;
  return guid.includes(';') ? guid.slice(guid.lastIndexOf(';') + 1) : guid;
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
    originalROWID: Number(chat.originalROWID) || 0,
    guid,
    style: Number(chat.style) || 0,
    chatIdentifier: inferredIdentifier,
    isArchived: chat.isArchived || false,
    displayName: chat.displayName || toDisplayIdentifier(guid),
    isFiltered: chat.isFiltered || false,
    groupId: chat.groupId || '',
    properties: chat.properties || {},
    lastAddressedHandle: chat.lastAddressedHandle || null
  };

  if (includeLastMessage) {
    const dateCreated = lastMessageDate != null ? Number(lastMessageDate) : null;
    response.lastMessage =
      chat.lastMessage ??
      (lastMessageText || dateCreated != null
        ? {
            text: lastMessageText || '',
            dateCreated, // ms since epoch (int for client)
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
    const chat = findChatByGuid(chats, chatGuid);

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
 * Body: { addresses: string[], message?: string, service?: 'iMessage'|'SMS' }. Returns chat in BlueBubbles envelope.
 */
router.post('/api/v1/chat/new', optionalAuthenticateToken, async (req, res) => {
  try {
    const { addresses = [], message, service } = req.body || {};
    let list = Array.isArray(addresses) ? addresses.map(a => String(a).trim()).filter(Boolean) : [];
    // Allow single address via query ?guid=... when body has no addresses (client compatibility)
    if (list.length === 0 && req.query?.guid) {
      const guid = String(req.query.guid).trim();
      if (guid) list = [guid];
    }
    if (list.length === 0) {
      return sendError(res, 400, 'addresses array is required and cannot be empty (or provide ?guid=...)', 'Bad Request');
    }
    const serviceType = (service === 'SMS' || service === 'iMessage') ? service : 'iMessage';
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
      chatGuid = `${serviceType};-;${normalized}`;
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
        originalROWID: 0 // int for client (Flutter int?)
      };
    }
    if (message && String(message).trim()) {
      try {
        await swiftDaemon.sendMessage(chatGuid, String(message).trim());
      } catch (sendErr) {
        logger.warn(`chat/new: optional initial message send failed: ${sendErr.message}`);
      }
    }
    sendSuccess(res, responseChat, 'Successfully created chat!');
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
    const queryGuid = req.query?.guid ? String(req.query.guid).trim() : null;
    let chats = await swiftDaemon.getChats();
    let chat = findChatByGuid(chats, chatGuid);

    // Fallback: client often sends ?guid= as alternate identifier (e.g. 1Easywayin! vs iMessage;-;14567894564)
    if (!chat && queryGuid) {
      chat = findChatByGuid(chats, queryGuid);
    }

    // Fallback: chat may not be in list (e.g. not recently active); try direct fetch from daemon
    if (!chat) {
      const direct = await swiftDaemon.getChat(chatGuid);
      if (direct) chat = direct;
      else if (queryGuid && queryGuid !== chatGuid) {
        const directByQuery = await swiftDaemon.getChat(queryGuid);
        if (directByQuery) chat = directByQuery;
      }
    }

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