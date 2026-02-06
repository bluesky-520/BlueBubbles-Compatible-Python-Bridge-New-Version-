import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import logger from '../config/logger.js';
import swiftDaemon from '../services/swift-daemon.js';
import sendCache from '../services/send-cache.js';
import { getFcmClientConfig } from '../services/fcm-config.js';
import { getServerMetadata } from '../services/server-metadata.js';
import {
  createSuccessResponse,
  createServerErrorResponse,
  createBadRequestResponse,
  createNoDataResponse,
  sendSocketResponse,
  ErrorTypes
} from '../utils/socket-response.js';
import { toClientTimestamp, unixMsToAppleNs } from '../utils/dates.js';
import { normalizeAttachment, resolveAttachmentPaths, getPrivateApiDir } from '../utils/attachments.js';
import { toMessageResponse } from '../utils/messages.js';

const VCF_PATH = path.resolve(process.cwd(), 'data', 'AddressBook.vcf');

/** Absolute path so daemon on same Mac can read built attachment files */
const CHUNKS_DIR = path.resolve(process.cwd(), 'data', 'attachment-chunks');

/** Official BlueBubbles private API dir (stable storage for outgoing attachments). */
const PRIVATE_API_DIR = getPrivateApiDir();
try {
  fs.mkdirSync(PRIVATE_API_DIR, { recursive: true });
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
  // Never delete files stored in the official private API dir (Messages can reference them later).
  try {
    const resolved = path.resolve(filePath);
    const privRoot = path.resolve(PRIVATE_API_DIR);
    if (resolved === privRoot || resolved.startsWith(privRoot + path.sep)) return;
  } catch (_) {}
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }, ATTACHMENT_DELETE_DELAY_MS);
}

function sanitizeAttachmentFilename(name) {
  const base = (name && typeof name === 'string') ? name.trim() : '';
  return base ? path.basename(base).replace(/[/\\]/g, '') || 'attachment' : 'attachment';
}

function moveToPrivateApi(srcPath, originalName = 'attachment') {
  const uuid = crypto.randomUUID();
  const dir = path.join(PRIVATE_API_DIR, uuid);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = sanitizeAttachmentFilename(originalName);
  const destPath = path.join(dir, safeName);
  try {
    fs.renameSync(srcPath, destPath);
    return destPath;
  } catch (_) {
    // Cross-device rename fallback
    fs.copyFileSync(srcPath, destPath);
    try { fs.unlinkSync(srcPath); } catch (_) {}
    return destPath;
  }
}

const ensureVcfDir = () => {
  const dir = path.dirname(VCF_PATH);
  fs.mkdirSync(dir, { recursive: true });
};

/** Save one chunk for chunked attachment upload (official BlueBubbles: saveAttachmentChunk). */
function saveAttachmentChunk(guid, chunkStart, buffer) {
  const dir = path.join(CHUNKS_DIR, guid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chunkStart}.chunk`), Buffer.from(buffer));
}

/** Build full file from chunks and return path (official BlueBubbles: buildAttachmentChunks). */
function buildAttachmentChunks(guid, name) {
  const dir = path.join(CHUNKS_DIR, guid);
  if (!fs.existsSync(dir)) throw new Error('No chunks found');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.chunk'));
  files.sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
  const buffers = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const outPath = path.join(dir, path.basename(String(name).replace(/[/\\]/g, '') || 'attachment'));
  fs.writeFileSync(outPath, Buffer.concat(buffers));
  return outPath;
}

/** Remove chunk directory after send. */
function deleteChunks(guid) {
  const dir = path.join(CHUNKS_DIR, guid);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch (_) {}
  }
}

const toChatIdentifier = (guid) => {
  if (!guid) return '';
  return guid.includes(';') ? guid.slice(guid.lastIndexOf(';') + 1) : guid;
};

/** Extract address from guid for display (never show internal ";-;" in UI). */
const toDisplayIdentifier = (guid) => {
  if (!guid) return '';
  const idx = guid.indexOf(';-;');
  if (idx >= 0) return guid.slice(idx + 3).trim();
  return toChatIdentifier(guid);
};

const toChatResponse = (chat) => {
  const lastMessageText = chat.lastMessageText ?? chat.last_message_text ?? '';
  const rawLastDate = chat.lastMessageDate ?? chat.last_message_date ?? 0;
  const lastMessageDate = toClientTimestamp(rawLastDate) ?? 0;
  const lastMessage = (lastMessageText || lastMessageDate)
    ? {
        text: lastMessageText || '',
        dateCreated: lastMessageDate,
        guid: null,
        isFromMe: false,
        handle: null
      }
    : null;
  const participants = Array.isArray(chat.participants) ? chat.participants : null;
  return {
    originalROWID: 0,
    guid: chat.guid,
    participants,
    messages: null,
    lastMessage,
    properties: chat.properties || null,
    style: 0,
    chatIdentifier: toChatIdentifier(chat.guid),
    isArchived: chat.isArchived || false,
    displayName: chat.displayName || toDisplayIdentifier(chat.guid),
    groupId: ''
  };
};

/** Parse optional numeric input from socket params. */
function parseOptionalNum(val) {
  if (val == null) return null;
  const s = (typeof val === 'string') ? val.trim() : val;
  if (s === '') return null;
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert client-provided timestamp to Apple ns when calling the Swift daemon.
 * BlueBubbles clients typically send Unix ms; some callers may already send Apple ns.
 */
function clientTimeToAppleNs(value) {
  const n = parseOptionalNum(value);
  if (n == null) return null;
  // Heuristic: Apple ns since 2001 is currently ~1e18; Unix ms is ~1e12
  if (n > 1e15) return Math.trunc(n);
  return unixMsToAppleNs(Math.trunc(n));
}

/**
 * Normalize client "after" value to Unix ms for comparisons.
 * Accepts either Unix ms or Apple ns.
 */
function clientTimeToUnixMs(value) {
  const n = parseOptionalNum(value);
  if (n == null) return null;
  if (n > 1e15) return toClientTimestamp(n);
  return Math.trunc(n);
}

const readLogs = (count = 100) => {
  try {
    const logPath = path.join(process.cwd(), 'logs', 'combined.log');
    if (!fs.existsSync(logPath)) return [];
    const data = fs.readFileSync(logPath, 'utf8');
    const lines = data.split(/\r?\n/).filter(Boolean);
    return lines.slice(-count);
  } catch (error) {
    logger.warn(`Failed to read logs: ${error.message}`);
    return [];
  }
};

/**
 * Register Socket.IO event handlers
 * @param {Socket} socket - Socket.IO socket
 * @param {SocketManager} socketManager - Socket manager instance
 */
export const registerSocketEvents = (socket, socketManager) => {
  const respond = (cb, channel, data) => sendSocketResponse(socket, cb, channel, data);

  // Debug: log every incoming socket event name (avoid logging payloads / base64).
  socket.onAny((eventName, ...args) => {
    try {
      const first = args?.[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        const keys = Object.keys(first);
        logger.debug(`[socket] event=${eventName} keys=${keys.slice(0, 25).join(',')}${keys.length > 25 ? ',...' : ''}`);
      } else {
        logger.debug(`[socket] event=${eventName}`);
      }
    } catch (_) {
      logger.debug(`[socket] event=${eventName}`);
    }
  });

  socket.on('get-server-metadata', async (_, cb) => {
    const meta = await getServerMetadata();
    return respond(cb, 'server-metadata', createSuccessResponse(meta, 'Successfully fetched metadata'));
  });

  socket.on('save-vcf', async (params, cb) => {
    if (!params?.vcf) {
      return respond(cb, 'error', createBadRequestResponse('No VCF data provided!'));
    }
    try {
      ensureVcfDir();
      fs.writeFileSync(VCF_PATH, params.vcf, 'utf8');
      return respond(cb, 'save-vcf', createSuccessResponse(null, 'Successfully saved VCF'));
    } catch (error) {
      return respond(cb, 'save-vcf', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-vcf', async (_, cb) => {
    try {
      if (!fs.existsSync(VCF_PATH)) {
        return respond(cb, 'save-vcf', createSuccessResponse(''));
      }
      const vcf = fs.readFileSync(VCF_PATH, 'utf8');
      return respond(cb, 'save-vcf', createSuccessResponse(vcf, 'Successfully retrieved VCF'));
    } catch (error) {
      return respond(cb, 'save-vcf', createServerErrorResponse(error.message));
    }
  });

  socket.on('change-proxy-service', async (params, cb) => {
    if (!params?.service) {
      return respond(cb, 'error', createBadRequestResponse('No service name provided!'));
    }
    return respond(cb, 'change-proxy-service', createSuccessResponse(null, 'Successfully set new proxy service!'));
  });

  socket.on('get-server-config', (_, cb) => {
    const config = {};
    return respond(cb, 'server-config', createSuccessResponse(config, 'Successfully fetched server config'));
  });

  socket.on('add-fcm-device', async (params, cb) => {
    if (!params?.deviceName || !params?.deviceId) {
      return respond(cb, 'error', createBadRequestResponse('No device name or ID specified'));
    }
    logger.info(`FCM device registered: ${params.deviceName} (${params.deviceId})`);
    return respond(cb, 'fcm-device-id-added', createSuccessResponse(null, 'Successfully added device ID'));
  });

  socket.on('get-fcm-client', async (_, cb) => {
    const fcm = getFcmClientConfig();
    return respond(cb, 'fcm-client', createSuccessResponse(fcm, 'Successfully got FCM data'));
  });

  socket.on('get-logs', async (params, cb) => {
    const count = params?.count ?? 100;
    const logs = readLogs(count);
    return respond(cb, 'logs', createSuccessResponse(logs));
  });

  socket.on('get-chats', async (params, cb) => {
    try {
      const chats = await swiftDaemon.getChats();
      const withArchived = params?.withArchived ?? false;
      const filtered = withArchived ? chats : chats.filter(chat => !chat.isArchived);
      const results = filtered.map(toChatResponse);
      return respond(cb, 'chats', createSuccessResponse(results));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-chat', async (params, cb) => {
    const chatGuid = params?.chatGuid;
    if (!chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided'));
    }
    try {
      const chats = await swiftDaemon.getChats();
      const chat = chats.find(c => c.guid === chatGuid);
      if (!chat) {
        return respond(cb, 'error', createBadRequestResponse('Chat does not exist (get-chat)!'));
      }
      return respond(cb, 'chat', createSuccessResponse(toChatResponse(chat)));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-chat-messages', async (params, cb) => {
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No chat identifier provided'));
    }
    try {
      const limitRaw = parseOptionalNum(params?.limit);
      const limit = Math.min(Math.max(limitRaw != null ? Math.trunc(limitRaw) : 100, 1), 1000);
      const beforeAppleNs = clientTimeToAppleNs(params?.before);
      const messages = await swiftDaemon.getMessages(
        params.identifier,
        limit,
        beforeAppleNs
      );
      const results = messages.map(msg => toMessageResponse(msg, params.identifier));
      return respond(cb, 'chat-messages', createSuccessResponse(results));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-messages', async (params, cb) => {
    if (!params?.after && !params?.limit) {
      return respond(cb, 'error', createBadRequestResponse('No `after` date or `limit` provided!'));
    }
    try {
      const chatGuid = params?.chatGuid;
      const limitRaw = parseOptionalNum(params?.limit);
      const limit = Math.min(Math.max(limitRaw != null ? Math.trunc(limitRaw) : 100, 1), 1000);
      const beforeAppleNs = clientTimeToAppleNs(params?.before);
      const afterUnixMs = clientTimeToUnixMs(params?.after);
      if (!chatGuid) {
        return respond(cb, 'messages', createSuccessResponse([]));
      }
      const messages = await swiftDaemon.getMessages(chatGuid, limit, beforeAppleNs);
      // Filter after in Unix ms space (daemon returns Apple ns in dateCreated)
      const filtered = afterUnixMs != null
        ? messages.filter(msg => (toClientTimestamp(msg.dateCreated) ?? 0) >= afterUnixMs)
        : messages;
      const chats = chatGuid ? [toChatResponse({ guid: chatGuid })] : null;
      const results = filtered.map(msg => toMessageResponse(msg, chatGuid, chats));
      return respond(cb, 'messages', createSuccessResponse(results));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-attachment', async (params, cb) => {
    logger.info('[socket get-attachment] identifier=%s withMessages=%s', params?.identifier ?? '(none)', params?.withMessages);
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No attachment identifier provided'));
    }
    try {
      const info = await swiftDaemon.getAttachmentInfo(params.identifier);
      if (!info) return respond(cb, 'error', createBadRequestResponse('Attachment does not exist'));
      const meta = normalizeAttachment(info);
      let data = null;
      try {
        const buf = await swiftDaemon.getAttachmentBuffer(params.identifier);
        data = buf.toString('base64');
      } catch (e) {
        logger.warn('[socket get-attachment] could not load data for %s: %s', params.identifier, e?.message);
      }
      const res = {
        ...meta,
        transferState: 0,
        isOutgoing: false,
        hideAttachment: false,
        isSticker: false,
        originalGuid: meta?.guid ?? info?.originalGuid ?? null,
        hasLivePhoto: false,
        data
      };
      if (params?.withMessages) res.messages = [];
      return respond(cb, 'attachment', createSuccessResponse(res));
    } catch (error) {
      logger.error('[socket get-attachment] error: %s', error?.message ?? error);
      return respond(cb, 'error', createServerErrorResponse(error?.message ?? 'Attachment lookup failed'));
    }
  });

  socket.on('get-attachment-chunk', async (params, cb) => {
    logger.info('[socket get-attachment-chunk] identifier=%s start=%s chunkSize=%s', params?.identifier ?? '(none)', params?.start, params?.chunkSize);
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No attachment identifier provided'));
    }
    const start = Math.max(0, parseInt(params?.start, 10) || 0);
    const chunkSize = Math.min(Math.max(1, parseInt(params?.chunkSize, 10) || 1024), 1024 * 1024);
    try {
      const buf = await swiftDaemon.getAttachmentChunk(params.identifier, start, chunkSize);
      if (!buf || buf.length === 0) return respond(cb, 'attachment-chunk', createNoDataResponse());
      return respond(cb, 'attachment-chunk', createSuccessResponse(buf.toString('base64')));
    } catch (error) {
      if (error?.response?.status === 404) return respond(cb, 'error', createBadRequestResponse('Attachment does not exist'));
      logger.error('[socket get-attachment-chunk] error: %s', error?.message ?? error);
      return respond(cb, 'error', createServerErrorResponse('Attachment not downloaded on server'));
    }
  });

  socket.on('get-last-chat-message', async (params, cb) => {
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No chat identifier provided'));
    }
    try {
      const messages = await swiftDaemon.getMessages(params.identifier, 1, null);
      if (!messages.length) {
        return respond(cb, 'last-chat-message', createNoDataResponse());
      }
      const result = toMessageResponse(messages[0], params.identifier);
      return respond(cb, 'last-chat-message', createSuccessResponse(result));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-participants', async (params, cb) => {
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No chat identifier provided'));
    }
    try {
      const chat = await swiftDaemon.getChat(params.identifier);
      if (!chat) {
        return respond(cb, 'error', createBadRequestResponse('Chat does not exist (get-participants)'));
      }
      const participants = Array.isArray(chat.participants) ? chat.participants : [];
      return respond(cb, 'participants', createSuccessResponse(participants));
    } catch (error) {
      logger.error(`get-participants error: ${error.message}`);
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('send-message', async (params, cb) => {
    const chatGuid = params?.guid;
    const tempGuid = params?.tempGuid;
    const message = params?.message;
    const hasInlineAttachment = !!(params?.attachment && params?.attachmentName && params?.attachmentGuid);
    let attachmentPaths = Array.isArray(params?.attachmentPaths) ? params.attachmentPaths.filter(Boolean) : [];
    logger.info(`[socket send-message] chatGuid=${chatGuid ?? '(missing)'} tempGuid=${tempGuid ?? '(missing)'} textLen=${(message || '').length} attachmentPaths=${attachmentPaths.length} inlineAttachment=${hasInlineAttachment}`);
    if (!chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided'));
    }
    if (!tempGuid) {
      return respond(cb, 'error', createBadRequestResponse('No temporary GUID provided with message'));
    }
    if (params?.attachment && !hasInlineAttachment) {
      return respond(cb, 'message-send-error', createServerErrorResponse('No attachment name or GUID provided'));
    }
    if ((message || '').trim() === '' && attachmentPaths.length === 0 && !hasInlineAttachment) {
      return respond(cb, 'error', createBadRequestResponse('Message text or attachmentPaths required'));
    }
    if (sendCache.find(tempGuid)) {
      return respond(
        cb,
        'error',
        createBadRequestResponse(`Message is already queued to be sent (Temp GUID: ${tempGuid})!`)
      );
    }
    let tempAttachmentPath = null;
    if (hasInlineAttachment) {
      try {
        const buf = Buffer.from(params.attachment, 'base64');
        const uuid = crypto.randomUUID();
        const dir = path.join(PRIVATE_API_DIR, uuid);
        fs.mkdirSync(dir, { recursive: true });
        const name = sanitizeAttachmentFilename(params.attachmentName || 'attachment');
        tempAttachmentPath = path.join(dir, name);
        fs.writeFileSync(tempAttachmentPath, buf);
        attachmentPaths = [tempAttachmentPath];
        logger.info('[socket send-message] saved inline attachment to %s', tempAttachmentPath);
      } catch (e) {
        logger.error('[socket send-message] failed to save inline attachment: %s', e?.message);
        return respond(cb, 'error', createServerErrorResponse('Failed to save attachment: ' + (e?.message ?? 'unknown')));
      }
    } else {
      attachmentPaths = resolveAttachmentPaths(attachmentPaths);
    }
    sendCache.add(tempGuid);
    try {
      const result = await swiftDaemon.sendMessage(chatGuid, message || '', {
        attachmentPaths: attachmentPaths.length ? attachmentPaths : undefined,
        tempGuid
      });
      const sentMessage = {
        guid: result?.guid || tempGuid,
        text: message || '',
        chatGuid,
        dateCreated: result?.dateCreated ?? Date.now(),
        isFromMe: true,
        type: 'text',
        error: 0
      };
      const msg = toMessageResponse(
        {
          ...sentMessage,
          dateCreated: toClientTimestamp(sentMessage.dateCreated) ?? Date.now()
        },
        chatGuid
      );
      msg.tempGuid = tempGuid;
      msg.guid = sentMessage.guid;
      sendCache.remove(tempGuid);
      if (tempAttachmentPath) scheduleAttachmentCleanup(tempAttachmentPath);
      logger.info(`[send-message] Success chatGuid=${chatGuid} tempGuid=${tempGuid} guid=${sentMessage.guid}`);
      socketManager.broadcastToChat(chatGuid, 'message.created', msg);
      return respond(cb, 'message-sent', createSuccessResponse(msg));
    } catch (error) {
      sendCache.remove(tempGuid);
      if (tempAttachmentPath) try { fs.unlinkSync(tempAttachmentPath); } catch (_) {}
      logger.error(`[send-message] Failed chatGuid=${chatGuid} tempGuid=${tempGuid} error=${error?.message ?? error}`);
      const errorData = {
        ...toMessageResponse(
          {
            guid: null,
            text: message || '',
            chatGuid,
            dateCreated: Date.now(),
            isFromMe: true,
            error: 4
          },
          chatGuid
        ),
        tempGuid,
        error: 4
      };
      return respond(
        cb,
        'message-send-error',
        createServerErrorResponse(
          error?.message ?? String(error),
          ErrorTypes.IMESSAGE_ERROR,
          'Failed to send message! See attached message error code.',
          errorData
        )
      );
    }
  });

  socket.on('send-message-chunk', async (params, cb) => {
    const chatGuid = params?.guid;
    const tempGuid = params?.tempGuid;
    const message = params?.message;
    const attachmentGuid = params?.attachmentGuid;
    const attachmentChunkStart = params?.attachmentChunkStart;
    const attachmentData = params?.attachmentData;
    const hasMore = params?.hasMore;
    const attachmentName = params?.attachmentName;

    logger.info('[socket send-message-chunk] chatGuid=%s tempGuid=%s hasMore=%s attachmentGuid=%s', chatGuid ?? '(none)', tempGuid ?? '(none)', hasMore, attachmentGuid ?? '(none)');

    if (!chatGuid) return respond(cb, 'error', createBadRequestResponse('No chat GUID provided'));
    if (!tempGuid) return respond(cb, 'error', createBadRequestResponse('No temporary GUID provided'));

    if (sendCache.find(tempGuid)) {
      return respond(cb, 'error', createBadRequestResponse('Attachment is already queued to be sent!'));
    }

    if (attachmentGuid && attachmentData != null) {
      try {
        const buf = Buffer.from(attachmentData, 'base64');
        saveAttachmentChunk(attachmentGuid, attachmentChunkStart ?? 0, buf);
      } catch (e) {
        logger.error('[send-message-chunk] save chunk failed: %s', e?.message);
        return respond(cb, 'error', createServerErrorResponse('Failed to save attachment chunk'));
      }
    }

    if (!hasMore) {
      if (attachmentGuid && !attachmentName) {
        return respond(cb, 'error', createBadRequestResponse('No attachment name provided'));
      }
      try {
        fs.mkdirSync(CHUNKS_DIR, { recursive: true });
      } catch (_) {}

      sendCache.add(tempGuid);
      let builtPath = null;
      if (attachmentGuid && attachmentName) {
        try {
          builtPath = buildAttachmentChunks(attachmentGuid, attachmentName);
          // Move final built file into the official private API directory so it stays accessible for previews/downloads.
          builtPath = moveToPrivateApi(builtPath, attachmentName);
        } catch (e) {
          sendCache.remove(tempGuid);
          logger.error('[send-message-chunk] buildAttachmentChunks failed: %s', e?.message);
          return respond(cb, 'error', createServerErrorResponse('Failed to build attachment from chunks'));
        }
      }

      try {
        const result = await swiftDaemon.sendMessage(chatGuid, message ?? '', {
          attachmentPaths: builtPath ? [builtPath] : undefined,
          tempGuid
        });
        const sentMessage = {
          guid: result?.guid || tempGuid,
          text: message ?? '',
          chatGuid,
          dateCreated: result?.dateCreated ?? Date.now(),
          isFromMe: true,
          type: 'text',
          error: 0
        };
        const msg = toMessageResponse(
          { ...sentMessage, dateCreated: toClientTimestamp(sentMessage.dateCreated) ?? Date.now() },
          chatGuid
        );
        msg.tempGuid = tempGuid;
        msg.guid = sentMessage.guid;
        sendCache.remove(tempGuid);
        if (attachmentGuid) deleteChunks(attachmentGuid);
        logger.info('[send-message-chunk] Success chatGuid=%s tempGuid=%s', chatGuid, tempGuid);
        socketManager.broadcastToChat(chatGuid, 'message.created', msg);
        return respond(cb, 'message-sent', createSuccessResponse(null));
      } catch (error) {
        sendCache.remove(tempGuid);
        if (attachmentGuid) deleteChunks(attachmentGuid);
        if (builtPath) {
          try { fs.unlinkSync(builtPath); } catch (_) {}
        }
        logger.error('[send-message-chunk] send failed: %s', error?.message ?? error);
        return respond(cb, 'send-message-error', createServerErrorResponse(error?.message ?? 'Send failed'));
      }
    }

    return respond(cb, 'message-chunk-saved', createSuccessResponse(null));
  });

  socket.on('start-chat', async (params, cb) => {
    return respond(cb, 'start-chat-failed', createServerErrorResponse('Chat creation not supported'));
  });

  socket.on('rename-group', async (params, cb) => {
    return respond(cb, 'rename-group-error', createServerErrorResponse('Group rename not supported'));
  });

  socket.on('add-participant', async (params, cb) => {
    return respond(cb, 'add-participant-error', createServerErrorResponse('Add participant not supported'));
  });

  socket.on('remove-participant', async (params, cb) => {
    return respond(cb, 'remove-participant-error', createServerErrorResponse('Remove participant not supported'));
  });

  socket.on('send-reaction', async (params, cb) => {
    return respond(cb, 'send-tapback-error', createServerErrorResponse('Reactions not supported'));
  });

  socket.on('get-contacts-from-vcf', async (_, cb) => {
    try {
      const vcf = await swiftDaemon.getContactsVcf();
      return respond(cb, 'contacts-from-vcf', createSuccessResponse(vcf));
    } catch (error) {
      return respond(cb, 'contacts-from-vcf', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-contacts', async (params, cb) => {
    const limit = params?.limit != null ? parseInt(params.limit, 10) : null;
    const offset = params?.offset != null ? parseInt(params.offset, 10) : null;
    const extraProps = Array.isArray(params?.extraProperties)
      ? params.extraProperties.filter(Boolean)
      : typeof params?.extraProperties === 'string'
        ? params.extraProperties.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    try {
      const contactsList = await swiftDaemon.getContacts({ limit, offset, extraProperties: extraProps });
      return respond(cb, 'contacts', createSuccessResponse(contactsList || []));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('getContacts', async (params, cb) => {
    const limit = params?.limit != null ? parseInt(params.limit, 10) : null;
    const offset = params?.offset != null ? parseInt(params.offset, 10) : null;
    const extraProps = Array.isArray(params?.extraProperties)
      ? params.extraProperties.filter(Boolean)
      : typeof params?.extraProperties === 'string'
        ? params.extraProperties.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    try {
      const contactsList = await swiftDaemon.getContacts({ limit, offset, extraProperties: extraProps });
      return respond(cb, 'contacts', createSuccessResponse(contactsList || []));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-contacts-full', async (params, cb) => {
    const limit = params?.limit != null ? parseInt(params.limit, 10) : null;
    const offset = params?.offset != null ? parseInt(params.offset, 10) : null;
    const extraProps = Array.isArray(params?.extraProperties)
      ? params.extraProperties.filter(Boolean)
      : typeof params?.extraProperties === 'string'
        ? params.extraProperties.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    try {
      const contactsList = await swiftDaemon.getContacts({ limit, offset, extraProperties: extraProps });
      return respond(cb, 'contacts', createSuccessResponse(contactsList || []));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('toggle-chat-read-status', (params) => {
    if (!params?.chatGuid || params?.status === null) return;
    socketManager.broadcastToChat(params.chatGuid, 'chat-read-status-changed', {
      chatGuid: params.chatGuid,
      status: params.status
    });
  });

  socket.on('open-chat', () => {});

  socket.on('started-typing', async (params, cb) => {
    if (!params?.chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided!'));
    }
    try {
      await swiftDaemon.sendTypingIndicator(params.chatGuid, true);
      return respond(cb, 'started-typing-sent', createSuccessResponse(null));
    } catch {
      return respond(cb, 'started-typing-error', createServerErrorResponse('Failed to stop typing'));
    }
  });

  socket.on('stopped-typing', async (params, cb) => {
    if (!params?.chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided!'));
    }
    try {
      await swiftDaemon.sendTypingIndicator(params.chatGuid, false);
      return respond(cb, 'stopped-typing-sent', createSuccessResponse(null));
    } catch {
      return respond(cb, 'stopped-typing-error', createServerErrorResponse('Failed to stop typing!'));
    }
  });

  socket.on('update-typing-status', async (params, cb) => {
    if (!params?.chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided!'));
    }
    return respond(cb, 'update-typing-status-sent', createSuccessResponse(null));
  });

  socket.on('restart-messages-app', async (_, cb) => {
    return respond(cb, 'restart-messages-app', createSuccessResponse(null));
  });

  socket.on('restart-private-api', async (_, cb) => {
    return respond(cb, 'restart-private-api-success', createSuccessResponse(null));
  });

  socket.on('check-for-server-update', async (_, cb) => {
    return respond(cb, 'save-vcf', createSuccessResponse({ available: false, current: '1.0.0', metadata: null }));
  });

  socket.on('disconnect', reason => {
    logger.info(`Client ${socket.id} disconnected! Reason: ${reason}`);
  });
};

export default registerSocketEvents;