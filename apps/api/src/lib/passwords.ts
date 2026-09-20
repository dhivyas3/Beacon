import { hash, verify } from '@node-rs/argon2';

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. When the user does not exist, `hashOrNull` is null and a dummy hash is
 * verified instead, so unknown emails and wrong passwords take the same time.
 */
export async function verifyPassword(
  hashOrNull: string | null,
  password: string,
): Promise<boolean> {
  if (hashOrNull === null) {
    dummyHash ??= hash('qa-hub-dummy-password');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(hashOrNull, password);
  } catch {
    return false;
  }
}
