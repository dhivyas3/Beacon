import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { abortable, chromiumArgs, DEFAULT_CHROMIUM_ARGS } from './browser.js';

describe('chromiumArgs', () => {
  it('always disables /dev/shm, and adds --no-sandbox only when asked', () => {
    expect(chromiumArgs(false)).toEqual(['--disable-dev-shm-usage']);
    expect(chromiumArgs(false)).toEqual(DEFAULT_CHROMIUM_ARGS);
    expect(chromiumArgs(true)).toEqual(['--disable-dev-shm-usage', '--no-sandbox']);
  });

  it('never mutates the shared default array', () => {
    const before = [...DEFAULT_CHROMIUM_ARGS];
    chromiumArgs(true);
    expect(DEFAULT_CHROMIUM_ARGS).toEqual(before);
  });
});

describe('abortable', () => {
  it('passes through the result and the error of a promise that settles', async () => {
    const signal = new AbortController().signal;
    await expect(abortable(Promise.resolve(7), signal)).resolves.toBe(7);
    await expect(abortable(Promise.reject(new Error('boom')), signal)).rejects.toThrow('boom');
  });

  it('settles when the signal aborts, even if the promise never does', async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise<never>(() => undefined), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('rejects at once for a signal that is already aborted, and swallows the late result', async () => {
    const controller = new AbortController();
    controller.abort();
    const late = Promise.reject(new Error('late failure'));
    await expect(abortable(late, controller.signal)).rejects.toThrow('aborted');
  });

  it('does not leave listeners on a long-lived signal', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 50; i += 1) await abortable(Promise.resolve(i), controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
