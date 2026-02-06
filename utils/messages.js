/**
 * BlueBubbles-compatible message serialization helpers.
 * Matches official MessageResponse shape where possible.
 */
import { toClientTimestamp } from './dates.js';
import { normalizeAttachments } from './attachments.js';

/**
 * Normalize a daemon/server message into BlueBubbles MessageResponse.
 * @param {Object} msg
 * @param {string} chatGuid
 * @param {Array|null} chats
 * @param {Object} [opts]
 * @param {string} [opts.tempGuid]
 */
export function toMessageResponse(msg, chatGuid, chats = null, opts = {}) {
  const tempGuid = opts?.tempGuid ?? msg?.tempGuid ?? undefined;
  const rawHandleId = msg?.handleId;
  const handleIdNum = (() => {
    const n = typeof rawHandleId === 'string' ? Number(rawHandleId) : rawHandleId;
    return Number.isFinite(n) ? n : 0;
  })();
  const otherHandleNum = (() => {
    const n = typeof msg?.otherHandle === 'string' ? Number(msg.otherHandle) : msg?.otherHandle;
    return Number.isFinite(n) ? n : 0;
  })();

  const output = {
    originalROWID: msg?.originalROWID ?? msg?.original_rowid ?? 0,
    tempGuid,
    guid: msg?.guid ?? null,
    text: msg?.text ?? '',
    handle: msg?.handle ?? null,
    handleId: handleIdNum,
    otherHandle: otherHandleNum,
    chats: chats || undefined,
    attachments: normalizeAttachments(msg?.attachments || []),
    subject: msg?.subject ?? '',
    error: msg?.error != null ? Number(msg.error) : 0,
    dateCreated: toClientTimestamp(msg?.dateCreated) ?? Date.now(),
    dateRead: toClientTimestamp(msg?.dateRead) ?? null,
    dateDelivered: toClientTimestamp(msg?.dateDelivered) ?? null,
    isFromMe: msg?.isFromMe || false,
    isArchived: msg?.isArchived || false,
    itemType: msg?.itemType ?? 0,
    groupTitle: msg?.groupTitle ?? null,
    groupActionType: msg?.groupActionType ?? 0,
    balloonBundleId: msg?.balloonBundleId ?? null,
    associatedMessageGuid: msg?.associatedMessageGuid || null,
    associatedMessageType: msg?.associatedMessageType || null,
    chatGuid: chatGuid || msg?.chatGuid || null
  };

  if (!output.tempGuid) delete output.tempGuid;
  return output;
}
