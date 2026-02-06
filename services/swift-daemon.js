import axios from 'axios';
import logger from '../config/logger.js';
import { resolveAttachmentPaths } from '../utils/attachments.js';

/**
 * IPC Client to communicate with Swift daemon
 * Handles all communication with localhost:8081
 */
class SwiftDaemonClient {
  constructor(baseUrl = process.env.SWIFT_DAEMON_URL || 'http://localhost:8081') {
    this.baseUrl = baseUrl;
    this.supportsUpdates = true;
    this.axios = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add response interceptor for error handling
    this.axios.interceptors.response.use(
      response => response,
      error => {
        const status = error?.response?.status;
        const requestUrl = error?.config?.url || '';
        const isUpdatesRequest = requestUrl.includes('/messages/updates');
        const isUnsupported = status === 404 || status === 501;

        if (!(isUpdatesRequest && isUnsupported)) {
          logger.error(`Swift daemon error: ${error.message}`);
        }
        throw error;
      }
    );
  }

  /**
   * Get all chats from Swift daemon
   * @returns {Promise<Array>} Array of chat objects
   */
  async getChats() {
    try {
      const response = await this.axios.get('/chats');
      logger.debug(`Fetched ${response.data.length} chats from Swift daemon`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch chats: ${error.message}`);
      throw new Error('Failed to fetch chats from Swift daemon');
    }
  }

  /**
   * Get a single chat by GUID (includes participants)
   * @param {string} chatGuid - Chat GUID
   * @returns {Promise<Object|null>} Chat object or null if not found
   */
  async getChat(chatGuid) {
    try {
      const response = await this.axios.get(`/chats/${encodeURIComponent(chatGuid)}`);
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404) return null;
      logger.error(`Failed to fetch chat ${chatGuid}: ${error.message}`);
      throw new Error('Failed to fetch chat');
    }
  }

  /**
   * Get messages for a specific chat
   * @param {string} chatGuid - Chat GUID
   * @param {number} limit - Number of messages to fetch
   * @param {number} [before] - Timestamp to fetch messages before
   * @returns {Promise<Array>} Array of message objects
   */
  async getMessages(chatGuid, limit = 50, before = null) {
    try {
      const params = { limit };
      if (before) params.before = before;

      const response = await this.axios.get(`/chats/${encodeURIComponent(chatGuid)}/messages`, { params });
      logger.debug(`Fetched ${response.data.length} messages for chat ${chatGuid}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch messages for chat ${chatGuid}: ${error.message}`);
      throw new Error('Failed to fetch messages');
    }
  }

  /**
   * Get contacts from Swift daemon (supports limit, offset, extraProperties like NativeBackend)
   * @param {Object} [opts]
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @param {string[]} [opts.extraProperties] - e.g. ['avatar']
   * @returns {Promise<Array>} Array of contact objects
   */
  async getContacts(opts = {}) {
    try {
      const params = {};
      if (opts.limit != null) params.limit = opts.limit;
      if (opts.offset != null) params.offset = opts.offset;
      if (Array.isArray(opts.extraProperties) && opts.extraProperties.length) {
        params.extraProperties = opts.extraProperties.join(',');
      }
      const response = await this.axios.get('/contacts', { params });
      logger.debug(`Fetched ${response.data.length} contacts from Swift daemon`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch contacts: ${error.message}`);
      throw new Error('Failed to fetch contacts from Swift daemon');
    }
  }

  /**
   * Get contacts as vCard string
   * @returns {Promise<string>} vCard contents
   */
  async getContactsVcf() {
    try {
      const response = await this.axios.get('/contacts/vcf');
      return response.data || '';
    } catch (error) {
      logger.error(`Failed to fetch contacts vCard: ${error.message}`);
      throw new Error('Failed to fetch contacts vCard');
    }
  }

  /**
   * Send message via AppleScript
   * @param {string} chatGuid - Chat GUID
   * @param {string} text - Message text
   * @param {Object} [opts] - Optional payload
   * @param {string[]} [opts.attachmentPaths] - POSIX paths to files to attach
   * @param {string} [opts.tempGuid] - Client-generated GUID for deduplication
   * @returns {Promise<Object>} Result from Swift daemon
   */
  async sendMessage(chatGuid, text, opts = {}) {
    try {
      const body = {
        chat_guid: chatGuid,
        text: text || ''
      };
      if (Array.isArray(opts.attachmentPaths) && opts.attachmentPaths.length) {
        body.attachment_paths = resolveAttachmentPaths(opts.attachmentPaths);
        logger.info(`Sending to daemon with attachment_paths: ${body.attachment_paths.join(', ')}`);
      }
      if (opts.tempGuid) body.temp_guid = opts.tempGuid;
      const response = await this.axios.post('/send', body);
      logger.info(`Message sent to chat ${chatGuid}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to send message: ${error.message}`);
      throw new Error('Failed to send message via Swift daemon');
    }
  }

  /**
   * Poll for updates (new messages, typing, receipts)
   * @param {number} since - Timestamp to check updates since
   * @returns {Promise<Object>} Updates object
   */
  async getUpdates(since) {
    try {
      if (!this.supportsUpdates) {
        return { messages: [], typing: [], receipts: [] };
      }

      const response = await this.axios.get('/messages/updates', {
        params: { since }
      });
      return response.data;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404 || status === 501) {
        // Endpoint not implemented yet - return empty and stop polling
        this.supportsUpdates = false;
        return { messages: [], typing: [], receipts: [] };
      }
      logger.error(`Failed to fetch updates: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send typing indicator to Swift daemon
   * @param {string} chatGuid - Chat GUID
   * @param {boolean} isTyping - Typing status
   */
  async sendTypingIndicator(chatGuid, isTyping) {
    try {
      await this.axios.post('/typing', {
        chat_guid: chatGuid,
        is_typing: isTyping
      });
    } catch (error) {
      logger.warn(`Failed to send typing indicator: ${error.message}`);
      // Don't throw - typing is best-effort
    }
  }

  /**
   * Send read receipt to Swift daemon (stored and returned in GET /messages/updates).
   * @param {string} chatGuid - Chat GUID
   * @param {string[]} messageGuids - Message GUIDs marked as read
   */
  async sendReadReceipt(chatGuid, messageGuids) {
    try {
      await this.axios.post('/read_receipt', {
        chat_guid: chatGuid,
        message_guids: messageGuids
      });
    } catch (error) {
      logger.warn(`Failed to send read receipt: ${error.message}`);
    }
  }

  /**
   * Get attachment metadata from Swift daemon (GET /attachments/:guid/info).
   * @param {string} guid - Attachment GUID
   * @returns {Promise<Object|null>} Attachment metadata or null if not found
   */
  async getAttachmentInfo(guid) {
    try {
      const response = await this.axios.get(`/attachments/${encodeURIComponent(guid)}/info`);
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404) return null;
      logger.error(`Failed to fetch attachment info ${guid}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch attachment file from Swift daemon (stream). Returns response with responseType 'stream'.
   * Forwards query params (e.g. original, height, width, quality) for official API compatibility.
   * @param {string} guid - Attachment GUID
   * @param {Object} [query] - Optional query params to forward
   * @param {Object} [opts]
   * @param {Object} [opts.headers] - Optional headers to pass through (e.g. Range)
   * @returns {Promise<Object>} Axios response with response.data as stream
   */
  async getAttachmentStream(guid, query = {}, opts = {}) {
    const response = await this.axios.get(`/attachments/${encodeURIComponent(guid)}`, {
      responseType: 'stream',
      timeout: 60000,
      params: query,
      headers: opts?.headers || undefined
    });
    return response;
  }

  /**
   * Fetch attachment as buffer (for socket get-attachment with loadData).
   * @param {string} guid - Attachment GUID
   * @returns {Promise<Buffer>} File bytes
   */
  async getAttachmentBuffer(guid) {
    const response = await this.axios.get(`/attachments/${encodeURIComponent(guid)}`, {
      responseType: 'arraybuffer',
      timeout: 60000
    });
    return Buffer.from(response.data);
  }

  /**
   * Fetch attachment chunk (Range request) for socket get-attachment-chunk.
   * @param {string} guid - Attachment GUID
   * @param {number} start - Byte start
   * @param {number} chunkSize - Number of bytes
   * @returns {Promise<Buffer>} Chunk bytes
   */
  async getAttachmentChunk(guid, start, chunkSize) {
    const end = start + chunkSize - 1;
    const response = await this.axios.get(`/attachments/${encodeURIComponent(guid)}`, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { Range: `bytes=${start}-${end}` }
    });
    return Buffer.from(response.data);
  }

  /**
   * Get database statistics totals (handles, messages, chats, attachments)
   * @param {Object} [opts]
   * @param {string} [opts.only] - Comma-separated: handle, message, chat, attachment
   * @returns {Promise<Object>} { handles, messages, chats, attachments }
   */
  async getStatisticsTotals(opts = {}) {
    try {
      const params = {};
      if (opts.only) params.only = opts.only;
      const response = await this.axios.get('/statistics/totals', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch statistics totals: ${error.message}`);
      throw new Error('Failed to fetch statistics totals from Swift daemon');
    }
  }

  /**
   * Get media statistics (images, videos, locations)
   * @param {Object} [opts]
   * @param {string} [opts.only] - Comma-separated: image, video, location
   * @returns {Promise<Object>} { images, videos, locations }
   */
  async getStatisticsMedia(opts = {}) {
    try {
      const params = {};
      if (opts.only) params.only = opts.only;
      const response = await this.axios.get('/statistics/media', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch statistics media: ${error.message}`);
      throw new Error('Failed to fetch statistics media from Swift daemon');
    }
  }

  /**
   * Health check
   * @returns {Promise<boolean>} True if Swift daemon is reachable
   */
  async ping() {
    try {
      await this.axios.get('/ping');
      return true;
    } catch (error) {
      logger.error(`Swift daemon unreachable: ${error.message}`);
      return false;
    }
  }
}

export default new SwiftDaemonClient();