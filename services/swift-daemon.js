import axios from 'axios';
import logger from '../config/logger.js';

/**
 * IPC Client to communicate with Swift daemon
 * Handles all communication with localhost:8081
 */
class SwiftDaemonClient {
  constructor(baseUrl = process.env.SWIFT_DAEMON_URL || 'http://localhost:8081') {
    this.baseUrl = baseUrl;
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
        logger.error(`Swift daemon error: ${error.message}`);
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

      const response = await this.axios.get(`/chats/${chatGuid}/messages`, { params });
      logger.debug(`Fetched ${response.data.length} messages for chat ${chatGuid}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch messages for chat ${chatGuid}: ${error.message}`);
      throw new Error('Failed to fetch messages');
    }
  }

  /**
   * Send message via AppleScript
   * @param {string} chatGuid - Chat GUID
   * @param {string} text - Message text
   * @returns {Promise<Object>} Result from Swift daemon
   */
  async sendMessage(chatGuid, text) {
    try {
      const response = await this.axios.post('/send', {
        chat_guid: chatGuid,
        text: text
      });
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
      const response = await this.axios.get('/messages/updates', {
        params: { since }
      });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // Endpoint not implemented yet - return empty
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