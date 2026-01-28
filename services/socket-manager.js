import { v4 as uuidv4 } from 'uuid';
import logger from '../config/logger.js';

/**
 * Manages Socket.IO connections, rooms, and device tracking
 */
class SocketManager {
  constructor(io) {
    this.io = io;
    this.connectedDevices = new Map(); // sid -> device info
    this.chatRooms = new Map(); // chatGuid -> Set of sids
  }

  /**
   * Handle client connection
   * @param {Socket} socket - Socket.IO socket
   */
  handleConnection(socket) {
    const deviceId = uuidv4();
    const userAgent = socket.handshake.headers['user-agent'] || 'unknown';

    this.connectedDevices.set(socket.id, {
      sid: socket.id,
      deviceId,
      userAgent,
      connectedAt: new Date().toISOString(),
      rooms: new Set()
    });

    logger.info(`Client connected: ${socket.id} (device: ${deviceId})`);

    // Join global room
    socket.join('global');

    // Send connection confirmation
    socket.emit('connection.confirmed', { deviceId });

    // Handle disconnection
    socket.on('disconnect', () => this.handleDisconnect(socket));

    // Handle join/leave chat room events
    socket.on('join_chat', (data) => this.handleJoinChat(socket, data));
    socket.on('leave_chat', (data) => this.handleLeaveChat(socket, data));
  }

  /**
   * Handle client disconnection
   * @param {Socket} socket - Socket.IO socket
   */
  handleDisconnect(socket) {
    const deviceInfo = this.connectedDevices.get(socket.id);
    if (deviceInfo) {
      logger.info(`Client disconnected: ${socket.id} (device: ${deviceInfo.deviceId})`);

      // Leave all chat rooms
      deviceInfo.rooms.forEach((chatGuid) => {
        this.leaveChatRoom(socket.id, chatGuid);
      });

      this.connectedDevices.delete(socket.id);
    }
  }

  /**
   * Handle client joining a chat room
   * @param {Socket} socket - Socket.IO socket
   * @param {Object} data - { chatGuid }
   */
  handleJoinChat(socket, data) {
    const { chatGuid } = data;
    if (!chatGuid) {
      logger.warn(`Client ${socket.id} tried to join chat without chatGuid`);
      return;
    }

    this.joinChatRoom(socket.id, chatGuid);
    socket.emit('chat.joined', { chatGuid });
    logger.debug(`Client ${socket.id} joined chat room: ${chatGuid}`);
  }

  /**
   * Handle client leaving a chat room
   * @param {Socket} socket - Socket.IO socket
   * @param {Object} data - { chatGuid }
   */
  handleLeaveChat(socket, data) {
    const { chatGuid } = data;
    if (chatGuid) {
      this.leaveChatRoom(socket.id, chatGuid);
      socket.emit('chat.left', { chatGuid });
      logger.debug(`Client ${socket.id} left chat room: ${chatGuid}`);
    }
  }

  /**
   * Join a chat room
   * @param {string} sid - Socket ID
   * @param {string} chatGuid - Chat GUID
   */
  joinChatRoom(sid, chatGuid) {
    const socket = this.io.sockets.sockets.get(sid);
    if (socket) {
      socket.join(chatGuid);
      
      // Track room membership
      const deviceInfo = this.connectedDevices.get(sid);
      if (deviceInfo) {
        deviceInfo.rooms.add(chatGuid);
      }

      // Track chat room members
      if (!this.chatRooms.has(chatGuid)) {
        this.chatRooms.set(chatGuid, new Set());
      }
      this.chatRooms.get(chatGuid).add(sid);
    }
  }

  /**
   * Leave a chat room
   * @param {string} sid - Socket ID
   * @param {string} chatGuid - Chat GUID
   */
  leaveChatRoom(sid, chatGuid) {
    const socket = this.io.sockets.sockets.get(sid);
    if (socket) {
      socket.leave(chatGuid);

      // Update tracking
      const deviceInfo = this.connectedDevices.get(sid);
      if (deviceInfo) {
        deviceInfo.rooms.delete(chatGuid);
      }

      const room = this.chatRooms.get(chatGuid);
      if (room) {
        room.delete(sid);
        if (room.size === 0) {
          this.chatRooms.delete(chatGuid);
        }
      }
    }
  }

  /**
   * Get number of clients in a chat room
   * @param {string} chatGuid - Chat GUID
   * @returns {number} Number of clients
   */
  getRoomClientCount(chatGuid) {
    const room = this.chatRooms.get(chatGuid);
    return room ? room.size : 0;
  }

  /**
   * Get all connected device IDs
   * @returns {Array} Array of device IDs
   */
  getConnectedDevices() {
    return Array.from(this.connectedDevices.values()).map(d => ({
      deviceId: d.deviceId,
      connectedAt: d.connectedAt,
      rooms: Array.from(d.rooms)
    }));
  }

  /**
   * Broadcast event to a specific chat room
   * @param {string} chatGuid - Chat GUID
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  broadcastToChat(chatGuid, event, data) {
    this.io.to(chatGuid).emit(event, data);
  }

  /**
   * Broadcast event to all connected clients
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  broadcastGlobal(event, data) {
    this.io.to('global').emit(event, data);
  }

  /**
   * Send event to specific socket
   * @param {string} sid - Socket ID
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  sendToSocket(sid, event, data) {
    const socket = this.io.sockets.sockets.get(sid);
    if (socket) {
      socket.emit(event, data);
    }
  }
}

export default SocketManager;