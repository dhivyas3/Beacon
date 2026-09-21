/**
 * HMAC-SHA256 helpers built on Web Crypto, so this package stays free of Node-only imports and can
 * be bundled for the browser. Used to sign callbacks and to sign the links in emails.
 */

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** The HMAC-SHA256 of `message` under `secret`, as lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), data));
}

/** Compares two strings without leaking, through timing, where they first differ. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** The value of the `X-Beacon-Signature` header for a callback body. */
export async function callbackSignature(secret: string, rawBody: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, rawBody)}`;
}

/** Checks a received signature against the raw body. Receivers should do exactly this. */
export async function verifyCallbackSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): Promise<boolean> {
  if (header === undefined) return false;
  return timingSafeEqualStrings(await callbackSignature(secret, rawBody), header.trim());
}

/**
 * A link token for one recipient: the recipient id and a signature, so a link in an email can act
 * for that person without a login, and cannot be forged or edited to act for someone else. The
 * secret is derived for this purpose so it is never the same key as the callback signature.
 */
export async function signRecipientToken(secret: string, recipientId: string): Promise<string> {
  const signature = await hmacSha256Hex(`${secret}:email-preferences`, recipientId);
  return `${recipientId}.${signature.slice(0, 32)}`;
}

/** Returns the recipient id in a token, or null when the token is malformed or was not signed here. */
export async function verifyRecipientToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const recipientId = token.slice(0, dot);
  const expected = await signRecipientToken(secret, recipientId);
  return timingSafeEqualStrings(expected, token) ? recipientId : null;
}
