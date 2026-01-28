import logger from '../config/logger.js';

/**
 * Register Socket.IO event handlers
 * @param {SocketManager} socketManager - Socket manager instance
 */
export const registerSocketEvents = (socketManager) => {
  // Events are already handled in SocketManager
  // This file can be extended for additional custom events
  logger.info('Socket.IO event handlers registered');
};

export default registerSocketEvents;