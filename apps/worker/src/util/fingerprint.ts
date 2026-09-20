import { createHash } from 'node:crypto';

/**
 * Identifies "the same problem" across pages. Two issues share a fingerprint when they come from
 * the same check, the same rule and the same subject (usually the resource URL), so a broken
 * footer link on 200 pages groups into one row that "affects 200 pages".
 */
export function fingerprintOf(checkType: string, rule: string, subject: string | null): string {
  return createHash('sha256')
    .update(`${checkType}\u0000${rule}\u0000${subject ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Makes messages comparable: numbers and long hashes vary between runs but mean the same thing. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
