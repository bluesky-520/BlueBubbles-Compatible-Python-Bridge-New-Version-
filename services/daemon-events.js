import logger from '../config/logger.js';

const DEFAULT_BASE_URL = process.env.SWIFT_DAEMON_URL || 'http://localhost:8081';
const RECONNECT_MS = 5000;
const POLL_INTERVAL_MS = 5000;

/**
 * Notify clients and invalidate cache when contacts changed.
 */
function emitContactsChanged(onContactsChanged, io, payload = { type: 'contacts_updated' }) {
  logger.info('Daemon: contacts_updated');
  onContactsChanged();
  if (io) {
    io.to('global').emit('contacts_updated', payload);
  }
}

/**
 * Poll GET /contacts/changed for lastChanged timestamp (used when SSE returns 500).
 */
function startPolling(baseUrl, onContactsChanged, io) {
  const url = `${baseUrl.replace(/\/$/, '')}/contacts/changed`;
  let lastChanged = 0;

  const poll = () => {
    fetch(url, { method: 'GET' })
      .then((res) => {
        if (!res.ok) return res.text().then(() => {});
        return res.json();
      })
      .then((data) => {
        if (data && typeof data.lastChanged === 'number' && data.lastChanged !== lastChanged) {
          if (lastChanged !== 0) {
            emitContactsChanged(onContactsChanged, io, {
              type: 'contacts_updated',
              timestamp: data.lastChanged
            });
          }
          lastChanged = data.lastChanged;
        }
      })
      .catch((err) => {
        logger.debug(`Daemon /contacts/changed poll error: ${err?.message}`);
      });
  };

  poll();
  return setInterval(poll, POLL_INTERVAL_MS);
}

/**
 * Subscribe to Swift daemon: try GET /events SSE first; on 5xx/stream error fall back to polling GET /contacts/changed.
 * On contacts_updated, calls onContactsChanged() and optionally broadcasts via Socket.IO.
 * @param {Object} opts
 * @param {string} [opts.baseUrl] - Daemon base URL
 * @param {Function} [opts.onContactsChanged] - Called when contacts_updated is received
 * @param {Object} [opts.io] - Socket.IO server; if set, broadcasts 'contacts_updated' to all clients
 */
export function subscribeToDaemonEvents(opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const onContactsChanged = opts.onContactsChanged || (() => {});
  const io = opts.io;

  const eventsUrl = `${baseUrl.replace(/\/$/, '')}/events`;
  let pollTimer = null;

  function handleEvent(event, data) {
    if (event === 'contacts_updated') {
      let payload = { type: 'contacts_updated' };
      if (typeof data === 'string') {
        try {
          payload = JSON.parse(data);
        } catch (_) {}
      } else if (data && typeof data === 'object') {
        payload = data;
      }
      emitContactsChanged(onContactsChanged, io, payload);
    }
  }

  function connect() {
    fetch(eventsUrl, { method: 'GET' })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Daemon events: ${res.status}`);
        }
        return res.body;
      })
      .then((body) => {
        if (!body) {
          throw new Error('No response body');
        }
        return readSSE(body, handleEvent);
      })
      .then(() => {
        logger.debug('Daemon events stream ended; reconnecting');
        setTimeout(connect, RECONNECT_MS);
      })
      .catch((err) => {
        const msg = err?.message || '';
        if (msg.includes('404') || msg.includes('501')) {
          logger.debug('Daemon /events not available; address book sync will use cache TTL');
          return;
        }
        if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
          logger.info('Daemon /events returned 5xx; using polling GET /contacts/changed for address book sync');
          if (!pollTimer) pollTimer = startPolling(baseUrl, onContactsChanged, io);
          return;
        }
        logger.warn(`Daemon events connection failed: ${msg}; reconnecting in ${RECONNECT_MS}ms`);
        setTimeout(connect, RECONNECT_MS);
      });
  }

  connect();
}

/**
 * Read Server-Sent Events from a ReadableStream.
 * @param {ReadableStream} stream
 * @param {Function} onEvent - (eventName, dataString) => void
 */
function readSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  function processLine(line) {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      currentData = line.slice(5).trim();
      return;
    }
    if (line === '') {
      if (currentEvent || currentData) {
        onEvent(currentEvent || 'message', currentData);
        currentEvent = '';
        currentData = '';
      }
    }
  }

  function pump() {
    return reader.read().then(({ done, value }) => {
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
      return pump();
    });
  }

  return pump();
}

export default { subscribeToDaemonEvents };
