/**
 * Listen for inbound messages on a chat room via Socket.IO.
 *
 * Usage:
 *   CHAT_GUID="SMS;-;+15551234567" PASSWORD="your-password" node scripts/listen-messages.js
 *
 * Optional env:
 *   SERVER_URL=http://localhost:8000
 */
import { io } from 'socket.io-client';
import dotenv from 'dotenv';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8000';
const PASSWORD = process.env.PASSWORD || process.env.SERVER_PASSWORD || '';
const CHAT_GUID = process.env.CHAT_GUID || '';

if (!PASSWORD) {
  console.error('Missing PASSWORD or SERVER_PASSWORD env var');
  process.exit(1);
}

if (!CHAT_GUID) {
  console.error('Missing CHAT_GUID env var');
  process.exit(1);
}

const socket = io(SERVER_URL, {
  query: { password: PASSWORD },
  transports: ['websocket', 'polling']
});

socket.on('connect', () => {
  console.log(`Connected: ${socket.id}`);
  socket.emit('join_chat', { chatGuid: CHAT_GUID });
  console.log(`Joined chat room: ${CHAT_GUID}`);
});

socket.on('new-message', (msg) => {
  console.log('new-message:', JSON.stringify(msg, null, 2));
});

socket.on('message.created', (msg) => {
  console.log('message.created:', JSON.stringify(msg, null, 2));
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});
