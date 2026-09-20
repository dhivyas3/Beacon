import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';

/**
 * Where screenshots and exports live. The API and worker only use this interface, so an S3
 * implementation can replace the local disk one without touching them.
 */
export interface Storage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Removes every object whose key starts with `prefix`, such as `screenshots/scn_abc/`. */
  deletePrefix(prefix: string): Promise<void>;
}

export interface StoredObject {
  data: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
};

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidStorageKeyError';
  }
}

/** Stores objects as files under one root directory. */
export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Maps a key to a path inside the root, refusing anything that could escape it. */
  private pathFor(key: string): string {
    const segments = key.split('/');
    const bad =
      key === '' ||
      key.includes('\\') ||
      key.includes('\0') ||
      key.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..');
    if (bad) throw new InvalidStorageKeyError(key);
    const full = resolve(join(this.root, ...segments));
    if (!full.startsWith(this.root + sep)) throw new InvalidStorageKeyError(key);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const data = await readFile(path);
      return {
        data,
        contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    await rm(this.pathFor(trimmed), { recursive: true, force: true });
  }
}

export function screenshotKey(scanId: string, issueId: string): string {
  return `screenshots/${scanId}/${issueId}.png`;
}
