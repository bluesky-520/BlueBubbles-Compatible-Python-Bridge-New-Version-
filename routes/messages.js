import express from 'express';
import axios from 'axios';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import swiftDaemon from '../services/swift-daemon.js';
import sendCache from '../services/send-cache.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError, sendBlueBubblesError, BLUEBUBBLES_ERROR_TYPES } from '../utils/envelope.js';
import { toClientTimestamp, unixMsToAppleNs } from '../utils/dates.js';
import { withIncludesAttachment, normalizeAttachments, normalizeAttachment, getPrivateApiDir, resolveAttachmentPaths } from '../utils/attachments.js';

const router = express.Router();

const privateApiDir = getPrivateApiDir();
try {
  fs.mkdirSync(privateApiDir, { recursive: true });
} catch (_) {}

// Temp dir for POST /api/v1/message/attachment (direct send)
const uploadDir = path.join(os.tmpdir(), 'bluebubbles-uploads');
try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (_) {}

/** Delay (ms) before deleting a sent attachment temp file so Messages.app can read it. Prevents "Not Delivered". */
const ATTACHMENT_DELETE_DELAY_MS = (() => {
  const raw = process.env.ATTACHMENT_DELETE_DELAY_MS;
  const n = raw != null ? parseInt(String(raw), 10) : NaN;
  // Default 10 minutes; allow override via env var
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
})();
function scheduleAttachmentCleanup(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  // Never delete files stored in the official BlueBubbles private API dir (Messages can reference them).
  try {
    const resolved = path.resolve(filePath);
    const privRoot = path.resolve(privateApiDir);
    if (resolved === privRoot || resolved.startsWith(privRoot + path.sep)) return;
  } catch (_) {}
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }, ATTACHMENT_DELETE_DELAY_MS);
}

// Official BlueBubbles: filename = original name, no path segments
function sanitizeAttachmentFilename(name) {
  const base = (name && typeof name === 'string') ? name.trim() : '';
  return base ? path.basename(base).replace(/[/\\]/g, '') || 'attachment' : 'attachment';
}

const uploadToPrivateApi = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const uuid = crypto.randomUUID();
      req._uploadUuid = uuid;
      const dir = path.join(privateApiDir, uuid);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return cb(e);
      }
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, sanitizeAttachmentFilename(file.originalname));
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
}).single('attachment');

/** n8n (or other) webhook URL - when set, POST message payload on send (fire-and-forget). */
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || process.env.WEBHOOK_MESSAGE_SENT_URL || '';

/**
 * Fire webhook trigger for new message (non-blocking).
 * Payload: { type: 'new-message', data: messagePayload } for n8n Webhook node.
 */
function fireMessageSentWebhook(data) {
  if (!WEBHOOK_URL || typeof WEBHOOK_URL !== 'string' || !WEBHOOK_URL.trim()) return;
  const payload = { type: 'new-message', data };
  axios
    .post(WEBHOOK_URL.trim(), payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    })
    .catch(err => {
      logger.warn(`Webhook trigger failed: ${err?.message || err}`);
    });
}

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
    attachments: normalizeAttachments(msg.attachments || []),
    associatedMessageGuid: msg.associatedMessageGuid || null,
    associatedMessageType: msg.associatedMessageType || null
  };
  if (tempGuid) payload.tempGuid = tempGuid;
  return payload;
}

/**
 * GET /api/v1/chat/:chatGuid/message
 * BlueBubbles-compatible message list (matches official server: query params, 404 when chat missing, metadata).
 * Query: limit (1-1000, default 50), offset (row offset, default 0), before, after (unix ms), sort (ASC|DESC), with (attachment, etc.).
 * Daemon returns chronological (oldest first). ASC = keep chronological; DESC = newest first. Default sort=ASC to match get-messages.
 */
/** Parse optional numeric query param; avoid truthy non-numeric values (e.g. ?before gives true). */
function parseOptionalNum(val) {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

router.get('/api/v1/chat/:chatGuid/message', optionalAuthenticateToken, async (req, res) => {
  try {
    const { chatGuid } = req.params;
    const limitRaw = req.query?.limit != null ? parseInt(req.query.limit, 10) : 50;
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 1000);
    const offset = Math.max(0, parseOptionalNum(req.query?.offset) ?? 0);
    const before = parseOptionalNum(req.query?.before);
    const after = parseOptionalNum(req.query?.after);
    const sortParam = req.query?.sort;
    const sort = (sortParam === 'ASC' || sortParam === 'DESC') ? sortParam : 'ASC';
    const withParam = req.query?.with ?? req.query?.withs ?? req.query?.withAttachments;
    const includeAttachments = withIncludesAttachment(withParam);

    // Official server: verify chat exists first → 404 "Chat does not exist!"
    const chat = await swiftDaemon.getChat(chatGuid);
    if (chat == null) {
      return sendError(res, 404, 'Chat does not exist!', 'Not Found');
    }

    // Daemon only supports limit + before; fetch enough for offset (request limit + offset, then slice)
    // Client sends before in Unix ms; daemon DB uses Apple ns (since 2001-01-01)
    const fetchLimit = Math.min(limit + offset, 1000);
    const beforeAppleNs = before != null ? unixMsToAppleNs(before) : null;
    const messages = await swiftDaemon.getMessages(
      chatGuid,
      fetchLimit,
      beforeAppleNs || undefined
    );

    // Optional client-side filter by after (daemon has no after param)
    let filtered = messages;
    if (after != null && after > 0) {
      filtered = messages.filter(msg => (toClientTimestamp(msg.dateCreated) ?? 0) > after);
    }
    // Daemon returns chronological (ASC). DESC = newest first = reverse.
    if (sort === 'DESC') {
      filtered = [...filtered].reverse();
    }
    // Apply offset (daemon has no offset param)
    const sliced = offset > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(0, limit);
    const formattedMessages = sliced.map(msg => {
      // Client expects handleId as int? (handle ROWID); daemon may send address string or empty. Send number or null only.
      const rawHandleId = msg.handleId;
      const handleId =
        rawHandleId != null && String(rawHandleId).trim() !== ''
          ? (Number(rawHandleId) || null)
          : null;
      const handleAddress = msg.sender || (typeof rawHandleId === 'string' ? rawHandleId : null);
      const rawAttachments = includeAttachments ? (msg.attachments || []) : [];
      const attachments = normalizeAttachments(rawAttachments);
      return {
      guid: msg.guid,
      text: msg.text || null,
      chatGuid: chatGuid,
      sender: msg.sender || 'Unknown',
      handleId,
      handle: handleAddress != null ? { address: handleAddress, id: handleId } : null,
      dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
      dateRead: toClientTimestamp(msg.dateRead) ?? null,
      isFromMe: msg.isFromMe !== false,
      attachments,
      subject: msg.subject || null,
      type: msg.type || 'text',
      error: msg.error != null ? Number(msg.error) : 0,
      associatedMessageGuid: msg.associatedMessageGuid || null,
      associatedMessageType: msg.associatedMessageType || null
      };
    });

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
 * Body: { chatGuid, message } or { chatGuid, text } required (official server uses "message"); { tempGuid, method, subject, effectId } optional.
 */
router.post('/api/v1/message/text', optionalAuthenticateToken, async (req, res) => {
  const tempGuidOrFallback = req.body?.tempGuid || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const { chatGuid: bodyChatGuid, tempGuid, text, message: bodyMessage, method = 'apple-script', subject, effectId, attachmentPaths } = req.body || {};
    // Allow chat identifier from query ?guid=... for client compatibility (e.g. BlueBubbles app)
    const chatGuid = bodyChatGuid ?? req.query?.guid ?? null;

    // Official BlueBubbles server uses "message" in body; accept both "message" and "text"
    const textStr = (bodyMessage != null ? String(bodyMessage) : text != null ? String(text) : '').trim();
    const rawPaths = Array.isArray(attachmentPaths) ? attachmentPaths.filter(Boolean) : [];
    const paths = resolveAttachmentPaths(rawPaths);
    logger.info(`POST /api/v1/message/text chatGuid=${chatGuid ?? '(missing)'} textLen=${textStr.length} attachments=${paths.length} queryGuid=${req.query?.guid ?? '(none)'}`);

    if (!chatGuid || (textStr === '' && paths.length === 0)) {
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

      fireMessageSentWebhook(data);

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
 * POST /api/v1/message/attachment
 * Official BlueBubbles: multipart form with file "attachment" and body chatGuid, name, tempGuid, method, etc.
 */
router.post('/api/v1/message/attachment', optionalAuthenticateToken, (req, res, next) => {
  // Save into the official private API directory (~/Library/Messages/Attachments/BlueBubbles)
  // so Messages.app can reference the file later and BlueBubbles clients can preview/download reliably.
  uploadToPrivateApi(req, res, (err) => {
    if (err) {
      logger.warn(`Message attachment upload error: ${err.message}`);
      return sendBlueBubblesError(res, 400, err.message || 'Attachment upload failed', {
        type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR
      });
    }
    next();
  });
}, async (req, res) => {
  const chatGuid = req.body?.chatGuid ?? req.query?.guid ?? null;
  const tempGuid = req.body?.tempGuid ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (!chatGuid) {
    return sendBlueBubblesError(res, 400, 'chatGuid is required', { type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR });
  }
  if (!req.file || !req.file.path) {
    return sendBlueBubblesError(res, 400, 'Attachment not provided or was empty!', {
      type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR
    });
  }

  if (sendCache.find(tempGuid)) {
    return sendBlueBubblesError(res, 400, 'Attachment is already queued to be sent!', {
      type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR
    });
  }

  const attachmentPath = req.file.path;
  sendCache.add(tempGuid);

  try {
    const result = await swiftDaemon.sendMessage(chatGuid, '', {
      attachmentPaths: [attachmentPath],
      tempGuid
    });

    sendCache.remove(tempGuid);
    // Do NOT delete: stored in private API dir for stability.

    const sentMessage = {
      guid: (result && result.guid) ? result.guid : tempGuid,
      text: '',
      chatGuid,
      dateCreated: result?.dateCreated ?? Date.now(),
      isFromMe: true,
      type: 'text',
      subject: null,
      error: 0
    };
    const data = toMessagePayload(sentMessage, chatGuid, { tempGuid });

    if (req.io) req.io.to(chatGuid).emit('message.created', data);
    fireMessageSentWebhook(data);
    logger.info(`Attachment sent to chat ${chatGuid}`);

    return sendSuccess(res, data, 'Attachment sent!', 200);
  } catch (sendErr) {
    sendCache.remove(tempGuid);
    try {
      fs.unlinkSync(attachmentPath);
    } catch (_) {}
    const errorMessage = sendErr?.message ?? 'Failed to send attachment';
    logger.error(`Send attachment error: ${errorMessage}`);
    const errorData = toMessagePayload(
      {
        guid: null,
        text: '',
        chatGuid,
        dateCreated: Date.now(),
        isFromMe: true,
        type: 'text',
        error: 4
      },
      chatGuid,
      { tempGuid, errorCode: 4 }
    );
    return res.status(500).json({
      status: 500,
      message: 'Attachment Send Error',
      error: 'Failed to send attachment! See attached message error code.',
      data: errorData
    });
  }
});

/**
 * GET /api/v1/message/count
 */
router.get('/api/v1/message/count', optionalAuthenticateToken, async (req, res) => {
  try {
    const afterRaw = req.query?.after;
    const after = afterRaw != null ? parseInt(String(afterRaw), 10) : NaN;
    if (!Number.isFinite(after) || after <= 0) {
      return sendSuccess(res, { count: 0 });
    }
    // Match official behavior: count of messages since "after" (Unix ms).
    // Use daemon updates endpoint (keeps code simple and compatible with daemon).
    const updates = await swiftDaemon.getUpdates(after).catch(() => ({ messages: [] }));
    const count = Array.isArray(updates?.messages) ? updates.messages.length : 0;
    return sendSuccess(res, { count });
  } catch (err) {
    logger.warn(`Message count error: ${err?.message || err}`);
    return sendSuccess(res, { count: 0 });
  }
});

/**
 * Serialize daemon attachment to official BlueBubbles AttachmentResponse (find endpoint).
 */
function serializeAttachmentFind(attachment) {
  const base = normalizeAttachment(attachment) || {};
  return {
    ...base,
    transferState: attachment?.transferState ?? 0,
    isOutgoing: attachment?.isOutgoing ?? false,
    hideAttachment: attachment?.hideAttachment ?? false,
    isSticker: attachment?.isSticker ?? false,
    originalGuid: attachment?.originalGuid ?? attachment?.guid ?? null,
    hasLivePhoto: false
  };
}

/**
 * Stream attachment file from Swift daemon. Forwards query (original, height, width, quality, force).
 */
async function streamAttachmentByGuid(req, res, guid) {
  if (!guid) {
    return sendBlueBubblesError(res, 400, 'Attachment GUID required', { type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR });
  }
  logger.debug(`Attachment download requested: guid=${guid}`);
  try {
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const passthroughHeaders = {};
    if (req.headers?.range) passthroughHeaders.Range = req.headers.range;

    const response = await swiftDaemon.getAttachmentStream(guid, query, { headers: passthroughHeaders });

    // Preserve daemon status + key headers (clients often rely on Range/Content-Range for previews)
    res.status(response.status);
    const headers = response.headers || {};
    const contentType = headers['content-type'];
    const contentDisposition = headers['content-disposition'];
    const contentLength = headers['content-length'];
    const contentRange = headers['content-range'];
    const acceptRanges = headers['accept-ranges'];
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    response.data.pipe(res);
  } catch (error) {
    if (error?.response?.status === 404) {
      logger.warn(`Attachment not found from daemon: guid=${guid}`);
      return sendBlueBubblesError(res, 404, 'Attachment does not exist!');
    }
    logger.error(`Attachment proxy error for guid=${guid}: ${error.message}`);
    sendError(res, 500, error.message);
  }
}

// ---- Attachment routes (order: most specific first; match official BlueBubbles API) ----

/**
 * GET /api/v1/attachment/count
 * Official: returns { data: { total } } from server attachment count.
 */
router.get('/api/v1/attachment/count', optionalAuthenticateToken, async (req, res) => {
  try {
    const stats = await swiftDaemon.getStatisticsTotals({ only: 'attachment' }).catch(() => ({}));
    const total = stats.attachments ?? 0;
    return sendSuccess(res, { total });
  } catch (err) {
    logger.error(`Attachment count error: ${err.message}`);
    return sendSuccess(res, { total: 0 });
  }
});

/**
 * POST /api/v1/attachment/upload
 * Official: multipart file "attachment"; saves to private-api dir; returns { data: { path: "uuid/filename" } }.
 * Client uses path in message/text attachmentPaths or message/multipart parts.
 */
router.post('/api/v1/attachment/upload', optionalAuthenticateToken, (req, res, next) => {
  uploadToPrivateApi(req, res, (err) => {
    if (err) {
      logger.warn(`Attachment upload error: ${err.message}`);
      return sendBlueBubblesError(res, 400, err.message || 'Attachment upload failed', {
        type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR
      });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file || !req.file.path) {
    return sendBlueBubblesError(res, 400, 'Attachment not provided or was empty!', {
      type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR
    });
  }
  const uuid = req._uploadUuid || path.basename(path.dirname(req.file.path));
  const filename = path.basename(req.file.path);
  // Official BlueBubbles: data.path is "uuid/filename" with forward slashes (client uses this in attachmentPaths)
  const dataPath = `${uuid}/${filename}`.replace(/\\/g, '/');
  return sendSuccess(res, { path: dataPath }, 'Success', 200);
});

/**
 * GET /api/v1/attachment/:guid/download/force
 * Official: force download then stream. We proxy to same stream as download.
 */
router.get('/api/v1/attachment/:guid/download/force', optionalAuthenticateToken, async (req, res) => {
  await streamAttachmentByGuid(req, res, req.params.guid);
});

/**
 * GET /api/v1/attachment/:guid/download
 * Official: stream file (query: original, height, width, quality, force).
 */
router.get('/api/v1/attachment/:guid/download', optionalAuthenticateToken, async (req, res) => {
  await streamAttachmentByGuid(req, res, req.params.guid);
});

/**
 * GET /api/v1/attachment/:guid/blurhash
 * Official: returns blurhash for image. We don't support; return 404 per official message.
 */
router.get('/api/v1/attachment/:guid/blurhash', optionalAuthenticateToken, async (req, res) => {
  const guid = req.params.guid;
  const info = await swiftDaemon.getAttachmentInfo(guid).catch(() => null);
  if (!info) return sendBlueBubblesError(res, 404, 'Attachment does not exist!');
  return sendBlueBubblesError(res, 404, 'Attachment is not an image!', { type: BLUEBUBBLES_ERROR_TYPES.DATABASE_ERROR });
});

/**
 * GET /api/v1/attachment/:guid/live
 * Official: stream live photo video. We don't support; return 404 per official message.
 */
router.get('/api/v1/attachment/:guid/live', optionalAuthenticateToken, async (req, res) => {
  const guid = req.params.guid;
  const info = await swiftDaemon.getAttachmentInfo(guid).catch(() => null);
  if (!info) return sendBlueBubblesError(res, 404, 'Attachment does not exist!');
  return sendBlueBubblesError(res, 404, 'Live photo does not exist for this attachment!');
});

/**
 * GET /api/v1/attachment/:guid
 * Official: find (metadata only). Returns AttachmentResponse JSON, not file stream.
 */
router.get('/api/v1/attachment/:guid', optionalAuthenticateToken, async (req, res) => {
  const guid = req.params.guid;
  if (!guid) {
    return sendBlueBubblesError(res, 400, 'Attachment GUID required', { type: BLUEBUBBLES_ERROR_TYPES.VALIDATION_ERROR });
  }
  try {
    const attachment = await swiftDaemon.getAttachmentInfo(guid);
    if (!attachment) return sendBlueBubblesError(res, 404, 'Attachment does not exist!');
    const data = serializeAttachmentFind(attachment);
    return sendSuccess(res, data);
  } catch (err) {
    logger.error(`Attachment find error for guid=${guid}: ${err.message}`);
    sendError(res, 500, err.message);
  }
});

export default router;