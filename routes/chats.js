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
      return sendError(res, 404, 'Chat does not exist!', 'Not Found');
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
 * Build a single message payload for API response (e.g. chat/new sent message).
 * Matches BlueBubbles message shape; handleId is int? (number or null).
 */
function toSentMessagePayload(sentResult, chatGuid, text, opts = {}) {
  const { tempGuid, subject = null } = opts;
  const rawDate = sentResult?.dateCreated != null ? Number(sentResult.dateCreated) : null;
  const dateCreated = rawDate != null ? (toClientTimestamp(rawDate) ?? Date.now()) : Date.now();
  const payload = {
    guid: sentResult?.guid ?? null,
    text: text ?? '',
    chatGuid,
    handleId: null,
    dateCreated,
    dateRead: null,
    isFromMe: true,
    type: 'text',
    subject,
    error: 0,
    attachments: [],
    associatedMessageGuid: null,
    associatedMessageType: null
  };
  if (tempGuid) payload.tempGuid = tempGuid;
  return payload;
}

/**
 * POST /api/v1/chat/new
 * Create or find chat. Body: addresses (required), message, service, tempGuid, subject.
 * Must be before /api/v1/chat/:chatGuid so "new" is not matched as chatGuid.
 */
router.post('/api/v1/chat/new', optionalAuthenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const { addresses = [], message, service = 'iMessage', tempGuid, subject } = body;

    let list = Array.isArray(addresses) ? addresses.map(a => String(a).trim()).filter(Boolean) : [];
    if (list.length === 0 && req.query?.guid) {
      const guid = String(req.query.guid).trim();
      if (guid) list = [guid];
    }
    if (list.length === 0) {
      return sendError(res, 400, 'No addresses provided!', 'Bad Request');
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
      responseChat = toChatResponse(chat, {
        includeParticipants: true,
        includeLastMessage: true,
        includeMessages: false
      });
    } else {
      chatGuid = `${serviceType};-;${normalized}`;
      responseChat = {
        originalROWID: 0,
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
        participants: list.map(addr => ({ address: addr }))
      };
    }

    const messageStr = message != null ? String(message).trim() : '';
    if (messageStr) {
      try {
        const sentResult = await swiftDaemon.sendMessage(chatGuid, messageStr, {
          tempGuid: tempGuid || undefined
        });
        responseChat.messages = [
          toSentMessagePayload(sentResult, chatGuid, messageStr, { tempGuid, subject: subject || null })
        ];
      } catch (sendErr) {
        logger.warn(`chat/new: initial message send failed: ${sendErr.message}`);
        responseChat.messages = [];
      }
    } else {
      responseChat.messages = [];
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
 * BlueBubbles-compatible: body.with (lastmessage, last-message, participants), body.guid (optional filter), body.sort, body.offset, body.limit.
 * Must be before /api/v1/chat/:chatGuid so "query" is not matched as chatGuid.
 */
router.post('/api/v1/chat/query', optionalAuthenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const withQuery = parseWithQuery(body.with);
    const withLastMessage = withQuery.includes('lastmessage') || withQuery.includes('last-message');
    const guid = body.guid != null ? String(body.guid).trim() : null;
    // Official server: ChatSerializer default is includeParticipants: true for query
    const includeParticipants = true;
    let sort = body.sort != null ? String(body.sort).trim() : null;
    const offsetRaw = body.offset != null ? parseInt(body.offset, 10) : 0;
    const offset = Number.isNaN(offsetRaw) || offsetRaw < 0 ? 0 : offsetRaw;
    const limitRaw = body.limit != null ? parseInt(body.limit, 10) : 1000;
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 1000 : limitRaw, 1), 1000);

    if (withLastMessage && !sort) sort = 'lastmessage';

    let chats = await swiftDaemon.getChats();
    if (guid) {
      let chat = findChatByGuid(chats, guid);
      if (!chat) chat = await swiftDaemon.getChat(guid).catch(() => null);
      if (!chat) return sendError(res, 404, 'Chat does not exist!', 'Not Found');
      chats = [chat];
    }

    const total = chats.length;
    const sliced = chats.slice(offset, offset + limit);
    const results = sliced.map(chat =>
      toChatResponse(chat, {
        includeParticipants,
        includeLastMessage: withLastMessage,
        includeMessages: false
      })
    );

    if (sort === 'lastmessage' && withLastMessage) {
      results.sort((a, b) => {
        const d1 = a.lastMessage?.dateCreated ?? 0;
        const d2 = b.lastMessage?.dateCreated ?? 0;
        if (d1 > d2) return -1;
        if (d1 < d2) return 1;
        return 0;
      });
    }

    sendSuccess(res, results, 'Success', 200, {
      count: results.length,
      total,
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
      return sendError(res, 404, 'Chat does not exist!', 'Not Found');
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