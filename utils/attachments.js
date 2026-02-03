/**
 * BlueBubbles-compatible attachment helpers.
 * Matches official server AttachmentSerializer / AttachmentResponse shape.
 */

/**
 * Parse BlueBubbles "with" query param (comma-separated; can be URL-encoded).
 * Returns true if client requested attachment(s).
 */
export function withIncludesAttachment(withParam) {
  if (withParam == null) return true;

  const values = Array.isArray(withParam) ? withParam : [withParam];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    const segments = decoded
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (segments.some(p => p === 'attachment' || p === 'attachments')) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize a single attachment from daemon to official BlueBubbles AttachmentResponse shape.
 * Daemon may send camelCase or snake_case; client expects camelCase.
 */
export function normalizeAttachment(a) {
  if (a == null || typeof a !== 'object') return null;
  const guid = a.guid ?? a.GUID ?? null;
  if (guid == null) return null;
  return {
    originalROWID: a.originalROWID ?? a.original_rowid ?? null,
    guid,
    uti: a.uti ?? '',
    mimeType: a.mimeType ?? a.mime_type ?? 'application/octet-stream',
    transferName: a.transferName ?? a.transfer_name ?? '',
    totalBytes: a.totalBytes ?? a.total_bytes ?? 0
  };
}

/**
 * Normalize an array of attachments (filters out invalid entries).
 */
export function normalizeAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeAttachment).filter(Boolean);
}
