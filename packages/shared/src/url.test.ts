import { describe, expect, it } from 'vitest';
import {
  hostnameMatchesEntry,
  isHostAllowed,
  looksLikePageUrl,
  matchesStagingPattern,
  normalizeUrl,
} from './url.js';

describe('normalizeUrl', () => {
  it('lowercases host, drops fragments and default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/About#team')).toBe('https://example.com/About');
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
  });

  it('strips tracking parameters and keeps the rest sorted', () => {
    expect(normalizeUrl('https://example.com/p?utm_source=x&b=2&a=1&fbclid=abc&gclid=z')).toBe(
      'https://example.com/p?a=1&b=2',
    );
  });

  it('applies a consistent trailing slash rule', () => {
    expect(normalizeUrl('https://example.com/about/')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com/about')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('../contact/?utm_medium=email', 'https://example.com/a/b/')).toBe(
      'https://example.com/a/contact',
    );
  });

  it('rejects non-http schemes and garbage', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:hi@example.com')).toBeNull();
    expect(normalizeUrl('ftp://example.com/file')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it('removes embedded credentials', () => {
    expect(normalizeUrl('https://user:pass@example.com/x')).toBe('https://example.com/x');
  });
});

describe('looksLikePageUrl', () => {
  it('accepts extensionless and html paths', () => {
    expect(looksLikePageUrl('https://example.com/about')).toBe(true);
    expect(looksLikePageUrl('https://example.com/index.html')).toBe(true);
    expect(looksLikePageUrl('https://example.com/')).toBe(true);
  });

  it('rejects assets and downloads', () => {
    expect(looksLikePageUrl('https://example.com/brochure.pdf')).toBe(false);
    expect(looksLikePageUrl('https://example.com/img/a.JPG')).toBe(false);
  });
});

describe('allowed domains', () => {
  it('matches exact entries only for that hostname', () => {
    expect(hostnameMatchesEntry('example.com', 'example.com')).toBe(true);
    expect(hostnameMatchesEntry('www.example.com', 'example.com')).toBe(false);
  });

  it('matches the apex and subdomains for wildcard entries', () => {
    expect(hostnameMatchesEntry('example.com', '*.example.com')).toBe(true);
    expect(hostnameMatchesEntry('www.example.com', '*.example.com')).toBe(true);
    expect(hostnameMatchesEntry('a.b.example.com', '*.example.com')).toBe(true);
  });

  it('does not match lookalike domains', () => {
    expect(hostnameMatchesEntry('evilexample.com', '*.example.com')).toBe(false);
    expect(hostnameMatchesEntry('example.com.evil.io', '*.example.com')).toBe(false);
  });

  it('is case insensitive and checks every entry', () => {
    expect(isHostAllowed('WWW.Example.com', ['other.io', '*.example.com'])).toBe(true);
    expect(isHostAllowed('example.org', ['other.io', '*.example.com'])).toBe(false);
    expect(isHostAllowed('example.org', [])).toBe(false);
  });
});

describe('matchesStagingPattern', () => {
  const patterns = ['localhost', 'staging.', 'dev.', '.netlify.app', '.vercel.app'];

  it('matches the default patterns', () => {
    expect(matchesStagingPattern('localhost', patterns)).toBe(true);
    expect(matchesStagingPattern('staging.example.com', patterns)).toBe(true);
    expect(matchesStagingPattern('api.dev.example.com', patterns)).toBe(true);
    expect(matchesStagingPattern('my-site.netlify.app', patterns)).toBe(true);
    expect(matchesStagingPattern('my-site.vercel.app', patterns)).toBe(true);
  });

  it('leaves production hosts alone', () => {
    expect(matchesStagingPattern('www.example.com', patterns)).toBe(false);
    expect(matchesStagingPattern('developer.example.com', patterns)).toBe(false);
    expect(matchesStagingPattern('netlify.app.example.com', patterns)).toBe(false);
  });
});

describe('computeTemplates', () => {
  it('groups pages that share a parent path with at least three siblings', async () => {
    const { computeTemplates } = await import('./url.js');
    const urls = [
      'https://x.com/',
      'https://x.com/about',
      'https://x.com/properties/12-oak-lane',
      'https://x.com/properties/3-elm-road',
      'https://x.com/properties/9-pine-close',
      'https://x.com/news/launch',
      'https://x.com/news/awards',
    ];
    const templates = computeTemplates(urls);
    expect(templates.get('https://x.com/')).toBeNull();
    expect(templates.get('https://x.com/about')).toBeNull();
    expect(templates.get('https://x.com/properties/3-elm-road')).toBe('/properties/:slug');
    expect(templates.get('https://x.com/news/launch')).toBeNull();
  });
});
