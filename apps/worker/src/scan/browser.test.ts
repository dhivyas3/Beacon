import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { abortable } from './browser.js';

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
