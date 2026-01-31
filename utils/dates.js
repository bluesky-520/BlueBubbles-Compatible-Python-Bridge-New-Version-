/**
 * Apple Messages chat.db stores message.date as nanoseconds since 2001-01-01.
 * BlueBubbles client expects milliseconds since Unix epoch (Dart DateTime range).
 * Converts raw daemon timestamps to client-safe ms since epoch.
 */

const UNIX_EPOCH_2001_MS = 978307200000; // 2001-01-01 00:00:00 UTC in ms

/**
 * Convert a timestamp from the Swift daemon to milliseconds since Unix epoch.
 * - Values > 1e15 are treated as Apple nanoseconds since 2001-01-01.
 * - Values already in a plausible ms range (1e12–1e14) are returned as-is.
 * @param {number|null|undefined} value - Raw value from daemon (or null/0)
 * @returns {number|null} Milliseconds since Unix epoch, or null if no value
 */
export function toClientTimestamp(value) {
  if (value == null || value === 0) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  // Apple Messages: nanoseconds since 2001-01-01
  if (v > 1e15) {
    return Math.round(v / 1e6 + UNIX_EPOCH_2001_MS);
  }
  // Already milliseconds (e.g. 13 digits, 1e12–1e14)
  if (v >= 1e12 && v <= 8640000000000000) return Math.round(v);
  // Fallback: assume nanoseconds since 2001
  if (v > 0) return Math.round(v / 1e6 + UNIX_EPOCH_2001_MS);
  return null;
}
