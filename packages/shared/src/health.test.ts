import { describe, expect, it } from 'vitest';
import { computeHealthScore, healthBand } from './health.js';
import { hasIdPrefix, idPrefixOf, newId } from './ids.js';

describe('computeHealthScore', () => {
  it('scores a clean site 100', () => {
    expect(computeHealthScore({ critical: 0, warnings: 0, pagesTotal: 200 })).toBe(100);
  });

  it('follows 100 - (critical * 5 + warnings) / pages * 10', () => {
    // (6 * 5 + 41) / 214 * 10 = 3.318 -> 96.68 -> 97
    expect(computeHealthScore({ critical: 6, warnings: 41, pagesTotal: 214 })).toBe(97);
    // (10 * 5 + 0) / 10 * 10 = 50
    expect(computeHealthScore({ critical: 10, warnings: 0, pagesTotal: 10 })).toBe(50);
  });

  it('clamps at zero', () => {
    expect(computeHealthScore({ critical: 500, warnings: 500, pagesTotal: 3 })).toBe(0);
  });

  it('treats zero pages as one page', () => {
    expect(computeHealthScore({ critical: 1, warnings: 0, pagesTotal: 0 })).toBe(50);
  });

  it('groups scores into bands', () => {
    expect(healthBand(95)).toBe('good');
    expect(healthBand(75)).toBe('fair');
    expect(healthBand(40)).toBe('poor');
  });
});

describe('ids', () => {
  it('creates prefixed 12 character ids', () => {
    const id = newId('scn');
    expect(id).toMatch(/^scn_[0-9A-Za-z]{12}$/);
    expect(hasIdPrefix(id, 'scn')).toBe(true);
    expect(hasIdPrefix(id, 'usr')).toBe(false);
    expect(idPrefixOf(id)).toBe('scn');
    expect(idPrefixOf('nope_123')).toBeNull();
  });

  it('does not collide in a large sample', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('iss')));
    expect(ids.size).toBe(5000);
  });
});
