import { describe, expect, it } from 'vitest';
import { formatNumber, parseScanUrl, pathOf, pluralise, relativeTime } from './format';

describe('relativeTime', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  it('says "just now" for the last few seconds', () => {
    expect(relativeTime(at(10), now)).toBe('just now');
  });

  it('uses minutes, hours and days', () => {
    expect(relativeTime(at(5 * 60), now)).toBe('5 minutes ago');
    expect(relativeTime(at(3 * 3600), now)).toBe('3 hours ago');
    expect(relativeTime(at(86400), now)).toBe('yesterday');
    expect(relativeTime(at(3 * 86400), now)).toBe('3 days ago');
  });

  it('is empty for missing dates', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
  });
});

describe('parseScanUrl', () => {
  it('accepts full URLs unchanged', () => {
    expect(parseScanUrl('https://www.example.com')).toBe('https://www.example.com/');
    expect(parseScanUrl('http://example.com/shop')).toBe('http://example.com/shop');
  });

  it('adds https to bare hostnames and trims spaces', () => {
    expect(parseScanUrl('example.com')).toBe('https://example.com/');
    expect(parseScanUrl('  www.example.com/path  ')).toBe('https://www.example.com/path');
  });

  it('rejects empty input, other schemes and text with spaces', () => {
    expect(parseScanUrl('')).toBeNull();
    expect(parseScanUrl('   ')).toBeNull();
    expect(parseScanUrl('ftp://example.com')).toBeNull();
    expect(parseScanUrl('javascript:alert(1)')).toBeNull();
    expect(parseScanUrl('not a url')).toBeNull();
  });
});

describe('small helpers', () => {
  it('shows only the path of a URL', () => {
    expect(pathOf('https://example.com/a/b?x=1')).toBe('/a/b?x=1');
    expect(pathOf('https://example.com')).toBe('/');
    expect(pathOf(null)).toBe('');
  });

  it('pluralises with a formatted count', () => {
    expect(pluralise(1, 'warning')).toBe('1 warning');
    expect(pluralise(2, 'warning')).toBe('2 warnings');
    expect(pluralise(1200, 'page')).toBe('1,200 pages');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});
