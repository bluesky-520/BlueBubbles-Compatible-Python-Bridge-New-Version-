/**
 * Send cache for tempGuids (matches bluebubbles-server EventCache semantics).
 * Used to prevent duplicate sends and to track in-flight message sends.
 * - add(tempGuid): register a send in progress
 * - remove(tempGuid): clear after success or error
 * - find(tempGuid): check if already queued/sending
 */

const items = [];

function add(tempGuid) {
  if (!tempGuid || typeof tempGuid !== 'string') return false;
  const existing = items.find(i => i.item === tempGuid);
  if (existing) return false;
  items.push({ date: Date.now(), item: tempGuid });
  return true;
}

function remove(tempGuid) {
  if (!tempGuid) return;
  const idx = items.findIndex(i => i.item === tempGuid);
  if (idx >= 0) items.splice(idx, 1);
}

function find(tempGuid) {
  if (!tempGuid) return null;
  const entry = items.find(i => i.item === tempGuid);
  return entry ? entry.item : null;
}

function purge() {
  items.length = 0;
}

export default {
  add,
  remove,
  find,
  purge
};
