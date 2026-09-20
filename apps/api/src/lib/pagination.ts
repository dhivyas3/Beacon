import { ApiError } from './errors.js';

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (decoded === '' || encodeCursor(decoded) !== cursor) {
    throw new ApiError(
      'bad_request',
      'The cursor is not valid. Use the nextCursor value from a previous response.',
    );
  }
  return decoded;
}

export interface KeysetArgs {
  take: number;
  cursor?: { id: string };
  skip?: number;
}

/**
 * Cursor pagination over rows with a unique `id` and a stable order. Fetches one extra row to
 * learn whether another page exists.
 */
export async function paginateById<T extends { id: string }>(
  limit: number,
  cursor: string | undefined,
  fetchRows: (args: KeysetArgs) => Promise<T[]>,
): Promise<{ rows: T[]; nextCursor: string | null }> {
  const args: KeysetArgs =
    cursor === undefined
      ? { take: limit + 1 }
      : { take: limit + 1, cursor: { id: decodeCursor(cursor) }, skip: 1 };
  const fetched = await fetchRows(args);
  const rows = fetched.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > limit && last !== undefined ? encodeCursor(last.id) : null;
  return { rows, nextCursor };
}
