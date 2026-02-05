/**
 * Test script for the send-message socket event.
 * Connects via Socket.IO, fetches chats, then sends a test message.
 *
 * Usage (from project root):
 *   node scripts/test-send-message-socket.js
 *
 * Optional env:
 *   SERVER_URL=http://localhost:8000  (default)
 *   PASSWORD=your-server-password     (required; or set in .env)
 */

import { io } from 'socket.io-client';
import dotenv from 'dotenv';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'https://loansbyblake.share.zrok.io';
const PASSWORD = process.env.PASSWORD || process.env.SERVER_PASSWORD || '1Easywayin%21';

if (!PASSWORD) {
  console.error('Set PASSWORD or SERVER_PASSWORD in .env or env (e.g. PASSWORD=secret node scripts/test-send-message-socket.js)');
  process.exit(1);
}

const socket = io(SERVER_URL, {
  query: { password: PASSWORD },
  transports: ['websocket', 'polling']
});

socket.on('connect', () => {
  console.log('Connected. Fetching chats...');
  socket.emit('get-chats', {}, (res) => {
    const data = res?.data;
    const chats = Array.isArray(data) ? data : data?.data;
    if (!chats?.length) {
      console.error('No chats returned. Response:', JSON.stringify(res, null, 2));
      socket.close();
      process.exit(1);
    }
    const chatGuid = 'SMS;-;+12135292188';
    console.log(`Using first chat: ${chatGuid}`);

    const tempGuid = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = 'This is test message';

    socket.emit('send-message', {
      guid: chatGuid,
      tempGuid,
      message
    }, (sendRes) => {
      console.log('send-message callback:', JSON.stringify(sendRes, null, 2));
      if (sendRes?.status === 200 && sendRes?.data) {
        console.log('Success. Message guid:', sendRes.data.guid);
      } else {
        console.log('Error or unexpected response.');
      }
      socket.close();
      process.exit(sendRes?.status === 200 ? 0 : 1);
    });
  });
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});

socket.on('connection.confirmed', (payload) => {
  console.log('Server confirmed connection:', payload?.deviceId);
});
