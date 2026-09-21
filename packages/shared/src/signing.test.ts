import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  callbackSignature,
  hmacSha256Hex,
  signRecipientToken,
  timingSafeEqualStrings,
  verifyCallbackSignature,
  verifyRecipientToken,
} from './signing.js';

const SECRET = 'a-long-test-secret-0123456789';

describe('hmacSha256Hex', () => {
  it('matches Node crypto, so receivers can verify with any standard library', async () => {
    const body = '{"event":"scan.completed","scan":{"id":"scn_1"}}';
    expect(await hmacSha256Hex(SECRET, body)).toBe(
      createHmac('sha256', SECRET).update(body).digest('hex'),
    );
    expect(await hmacSha256Hex(SECRET, '')).toBe(
      createHmac('sha256', SECRET).update('').digest('hex'),
    );
  });

  it('signs bytes and text the same way, including non-ASCII', async () => {
    const text = 'Café 🚨 – ünïcode';
    expect(await hmacSha256Hex(SECRET, new TextEncoder().encode(text))).toBe(
      await hmacSha256Hex(SECRET, text),
    );
    expect(await hmacSha256Hex(SECRET, text)).toBe(
      createHmac('sha256', SECRET).update(text, 'utf8').digest('hex'),
    );
  });
});

describe('timingSafeEqualStrings', () => {
  it('is true only for identical strings, whatever their lengths', () => {
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStrings('', '')).toBe(true);
    expect(timingSafeEqualStrings('', 'a')).toBe(false);
  });
});

describe('callback signatures', () => {
  it('prefixes sha256= and verifies against the exact raw body', async () => {
    const body = '{"a":1}';
    const header = await callbackSignature(SECRET, body);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyCallbackSignature(SECRET, body, header)).toBe(true);
  });

  it('rejects a changed body, a wrong secret, a missing or altered header', async () => {
    const header = await callbackSignature(SECRET, '{"a":1}');
    expect(await verifyCallbackSignature(SECRET, '{"a":2}', header)).toBe(false);
    expect(await verifyCallbackSignature('another-secret-0123456789', '{"a":1}', header)).toBe(
      false,
    );
    expect(await verifyCallbackSignature(SECRET, '{"a":1}', undefined)).toBe(false);
    expect(await verifyCallbackSignature(SECRET, '{"a":1}', header.replace('sha256=', ''))).toBe(
      false,
    );
    expect(await verifyCallbackSignature(SECRET, '{"a":1}', `${header}0`)).toBe(false);
  });
});

describe('recipient tokens', () => {
  it('round-trips, and cannot be edited to act for someone else', async () => {
    const token = await signRecipientToken(SECRET, 'rcp_Ab12Cd34Ef56');
    expect(token.startsWith('rcp_Ab12Cd34Ef56.')).toBe(true);
    expect(await verifyRecipientToken(SECRET, token)).toBe('rcp_Ab12Cd34Ef56');

    const forged = token.replace('rcp_Ab12Cd34Ef56', 'rcp_Zz99Yy88Xx77');
    expect(await verifyRecipientToken(SECRET, forged)).toBeNull();
  });

  it('rejects malformed tokens and tokens signed with another secret', async () => {
    const token = await signRecipientToken(SECRET, 'rcp_Ab12Cd34Ef56');
    for (const bad of ['', '.', 'nodot', '.abc', `${token}x`, token.slice(0, -2)]) {
      expect(await verifyRecipientToken(SECRET, bad)).toBeNull();
    }
    expect(await verifyRecipientToken('another-secret-0123456789', token)).toBeNull();
  });

  it('is not the callback signature, so one cannot stand in for the other', async () => {
    const id = 'rcp_Ab12Cd34Ef56';
    const token = await signRecipientToken(SECRET, id);
    expect(token.split('.')[1]).not.toBe((await hmacSha256Hex(SECRET, id)).slice(0, 32));
  });
});
