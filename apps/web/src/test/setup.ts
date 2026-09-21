import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';

// Pages are loaded lazily, and the first load compiles them, which is slow when packages run in parallel.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

// The app loads these pages on demand. Loading them once up front keeps the first test that
// navigates to one from paying for compiling it, which is slow when packages test in parallel.
beforeAll(async () => {
  await Promise.all([
    import('@/pages/scan'),
    import('@/pages/settings'),
    import('@/pages/website-detail'),
    import('@/pages/website-form'),
  ]);
}, 60_000);

beforeEach(() => {
  // jsdom lacks these browser APIs, which Radix, Recharts and the theme code use.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

Element.prototype.scrollIntoView = () => undefined;
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => undefined;
Element.prototype.setPointerCapture = () => undefined;
window.HTMLElement.prototype.scrollIntoView = () => undefined;

if (!('randomUUID' in crypto)) {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000000',
  });
}
