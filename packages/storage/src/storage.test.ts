import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidStorageKeyError, LocalStorage, screenshotKey } from './index.js';

let dir: string;
let storage: LocalStorage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beacon-storage-'));
  storage = new LocalStorage(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('stores and reads back an object with its content type', async () => {
    const key = screenshotKey('scn_abc', 'iss_def');
    await storage.put(key, Buffer.from('png-bytes'));
    const object = await storage.get(key);
    expect(object?.data.toString()).toBe('png-bytes');
    expect(object?.contentType).toBe('image/png');
  });

  it('returns null for a missing key', async () => {
    expect(await storage.get('screenshots/none/none.png')).toBeNull();
  });

  it('deletes single objects and whole prefixes', async () => {
    await storage.put('screenshots/scn_a/1.png', Buffer.from('1'));
    await storage.put('screenshots/scn_a/2.png', Buffer.from('2'));
    await storage.put('screenshots/scn_b/1.png', Buffer.from('3'));

    await storage.delete('screenshots/scn_a/1.png');
    expect(await storage.get('screenshots/scn_a/1.png')).toBeNull();
    expect(await storage.get('screenshots/scn_a/2.png')).not.toBeNull();

    await storage.deletePrefix('screenshots/scn_a/');
    expect(await storage.get('screenshots/scn_a/2.png')).toBeNull();
    expect(await storage.get('screenshots/scn_b/1.png')).not.toBeNull();
  });

  it.each([
    '../escape.png',
    'a/../../escape.png',
    '/etc/passwd',
    'a//b.png',
    'a\\b.png',
    '',
    '.',
    'a/./b.png',
    'a\0b.png',
  ])('refuses the unsafe key %j', async (key) => {
    await expect(storage.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });

  it('cannot delete the storage root through an empty prefix', async () => {
    await expect(storage.deletePrefix('')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.deletePrefix('/')).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});
