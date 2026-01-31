import os from 'os';
import swiftDaemon from './swift-daemon.js';

const parseBool = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
};

const getLocalIps = (family) => {
  const nets = os.networkInterfaces();
  const results = [];
  Object.values(nets).forEach(ifaceList => {
    (ifaceList || []).forEach(details => {
      if (details.family === family && !details.internal) {
        results.push(details.address);
      }
    });
  });
  return results;
};

const computeComputerId = () => {
  const user = os.userInfo().username || 'unknown';
  const host = os.hostname() || 'unknown';
  return `${user}@${host}`;
};

export const getServerMetadata = async () => {
  const envPrivateApi = parseBool(
    process.env.ENABLE_PRIVATE_API ||
      process.env.PRIVATE_API ||
      process.env.PRIVATE_API_ENABLED
  );

  const daemonReachable = await swiftDaemon.ping().catch(() => false);
  const privateApiEnabled = envPrivateApi ?? daemonReachable;

  return {
    computer_id: computeComputerId(),
    os_version: `${os.platform()} ${os.release()}`,
    server_version: process.env.SERVER_VERSION || '1.0.0',
    private_api: privateApiEnabled,
    proxy_service: process.env.PROXY_SERVICE || 'zrok',
    helper_connected: daemonReachable,
    detected_icloud: process.env.DETECTED_ICLOUD || '',
    detected_imessage: process.env.DETECTED_IMESSAGE || '',
    macos_time_sync: null,
    local_ipv4s: getLocalIps('IPv4'),
    local_ipv6s: getLocalIps('IPv6')
  };
};
