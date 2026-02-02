import fs from 'fs';
import path from 'path';
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
import { toClientTimestamp } from '../utils/dates.js';

const VCF_PATH = path.join(process.cwd(), 'data', 'AddressBook.vcf');

const ensureVcfDir = () => {
  const dir = path.dirname(VCF_PATH);
  fs.mkdirSync(dir, { recursive: true });
};

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

const toMessageResponse = (msg, chatGuid, chats = null) => ({
  originalROWID: 0,
  tempGuid: msg.tempGuid || undefined,
  guid: msg.guid,
  text: msg.text || '',
  handle: null,
  handleId: 0,
  otherHandle: 0,
  chats: chats || undefined,
  attachments: msg.attachments || [],
  subject: msg.subject || '',
  error: 0,
  dateCreated: toClientTimestamp(msg.dateCreated) ?? Date.now(),
  dateRead: toClientTimestamp(msg.dateRead) ?? null,
  dateDelivered: null,
  isFromMe: msg.isFromMe || false,
  isArchived: false,
  itemType: 0,
  groupTitle: null,
  groupActionType: 0,
  balloonBundleId: null,
  associatedMessageGuid: msg.associatedMessageGuid || null,
  associatedMessageType: msg.associatedMessageType || null,
  chatGuid
});

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
      const messages = await swiftDaemon.getMessages(
        params.identifier,
        params?.limit ?? 100,
        params?.before ?? null
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
      const limit = params?.limit ?? 100;
      const before = params?.before ?? null;
      const after = params?.after ?? null;
      if (!chatGuid) {
        return respond(cb, 'messages', createSuccessResponse([]));
      }
      const messages = await swiftDaemon.getMessages(chatGuid, limit, before);
      const filtered = after
        ? messages.filter(msg => (msg.dateCreated || 0) >= after)
        : messages;
      const chats = chatGuid ? [toChatResponse({ guid: chatGuid })] : null;
      const results = filtered.map(msg => toMessageResponse(msg, chatGuid, chats));
      return respond(cb, 'messages', createSuccessResponse(results));
    } catch (error) {
      return respond(cb, 'error', createServerErrorResponse(error.message));
    }
  });

  socket.on('get-attachment', async (params, cb) => {
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No attachment identifier provided'));
    }
    return respond(cb, 'error', createServerErrorResponse('Attachment lookup not supported in bridge'));
  });

  socket.on('get-attachment-chunk', async (params, cb) => {
    if (!params?.identifier) {
      return respond(cb, 'error', createBadRequestResponse('No attachment identifier provided'));
    }
    return respond(cb, 'attachment-chunk', createNoDataResponse());
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
    const attachmentPaths = Array.isArray(params?.attachmentPaths) ? params.attachmentPaths.filter(Boolean) : [];
    if (!chatGuid) {
      return respond(cb, 'error', createBadRequestResponse('No chat GUID provided'));
    }
    if (!tempGuid) {
      return respond(cb, 'error', createBadRequestResponse('No temporary GUID provided with message'));
    }
    if (params?.attachment) {
      return respond(cb, 'message-send-error', createServerErrorResponse('Use attachmentPaths (array of server file paths) for attachments'));
    }
    if ((message || '').trim() === '' && attachmentPaths.length === 0) {
      return respond(cb, 'error', createBadRequestResponse('Message text or attachmentPaths required'));
    }
    if (sendCache.find(tempGuid)) {
      return respond(
        cb,
        'error',
        createBadRequestResponse(`Message is already queued to be sent (Temp GUID: ${tempGuid})!`)
      );
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
      return respond(cb, 'message-sent', createSuccessResponse(msg));
    } catch (error) {
      sendCache.remove(tempGuid);
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
          error.message,
          ErrorTypes.IMESSAGE_ERROR,
          'Failed to send message! See attached message error code.',
          errorData
        )
      );
    }
  });

  socket.on('send-message-chunk', async (params, cb) => {
    return respond(cb, 'error', createServerErrorResponse('Chunked attachments not supported'));
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