import type { EmailIssue, EmailLinks, FailedEmailData, ReportEmailData } from './types.js';

/** Sample data for the preview and the tests. Nothing here is real. */

const LINKS: EmailLinks = {
  report: 'https://beacon.example.com/scans/scn_a1B2c3D4e5F6',
  website: 'https://beacon.example.com/websites/web_a1B2c3D4e5F6',
  preferences:
    'https://beacon.example.com/api/v1/email/preferences/rcp_Ab12Cd34Ef56.0123456789abcdef',
  unsubscribe:
    'https://beacon.example.com/api/v1/email/preferences/rcp_Ab12Cd34Ef56.0123456789abcdef/unsubscribe',
};

const COMMON = {
  website: {
    name: 'Example Estates',
    url: 'https://www.example-estates.co.uk/',
    hostname: 'www.example-estates.co.uk',
  },
  recipient: { name: 'Sam Owner', email: 'owner@example-estates.co.uk' },
  links: LINKS,
};

const CHECK = {
  runNumber: 7,
  finishedAt: '2026-09-21T06:04:12.000Z',
  pagesChecked: 8,
  selection: '8 pages sampled, homepage included',
  trigger: 'Scheduled check',
};

function history(scores: number[]): { score: number; at: string }[] {
  return scores.map((score, index) => ({
    score,
    at: new Date(Date.UTC(2026, 9 - scores.length + index, 1, 6)).toISOString(),
  }));
}

const issue = (
  severity: EmailIssue['severity'],
  message: string,
  page: string,
  check: string,
  isNew: boolean,
  pages = 1,
): EmailIssue => ({ severity, message, page, check, isNew, pages });

/** Problems since the last check, and a score that fell. */
export const attention: ReportEmailData = {
  ...COMMON,
  kind: 'report',
  check: CHECK,
  score: 61,
  previousScore: 78,
  critical: 4,
  warnings: 9,
  history: history([84, 82, 88, 86, 91, 78, 61]),
  counts: { newCritical: 3, newWarnings: 2, stillOpen: 8, totalOpen: 13 },
  issues: [
    issue('critical', 'Image failed to load (HTTP 404).', '/property/12-oak-lane', 'Images', true),
    issue(
      'critical',
      'Submitting the form failed (HTTP 500). Visitors cannot use it.',
      '/contact',
      'Forms',
      true,
    ),
    issue(
      'critical',
      'The page tells search engines not to index it (noindex).',
      '/property/for-sale',
      'SEO',
      true,
    ),
    issue(
      'warning',
      'The page has no meta description, so search engines pick a snippet at random.',
      '/about',
      'SEO',
      true,
    ),
    issue(
      'warning',
      'JavaScript console error: Widget failed to initialise',
      '/',
      'Page health',
      true,
    ),
    issue(
      'critical',
      'Broken link: /brochure-2025.pdf returns HTTP 404.',
      '/property/12-oak-lane',
      'Links',
      false,
      6,
    ),
    issue('warning', 'Image has no alt attribute.', '/', 'Images', false),
    issue('warning', 'Social sharing tags are missing (og:image).', '/about', 'SEO', false),
    issue('warning', 'The canonical link points to a different site.', '/valuation', 'SEO', false),
    issue(
      'warning',
      'The title is 84 characters. Search results cut it off after about 70.',
      '/property/for-sale',
      'SEO',
      false,
    ),
  ],
  isFirstCheck: false,
};

/** Nothing new, and the score improved. */
export const allClear: ReportEmailData = {
  ...COMMON,
  kind: 'report',
  check: CHECK,
  score: 96,
  previousScore: 92,
  critical: 0,
  warnings: 2,
  history: history([88, 90, 89, 92, 92, 96]),
  counts: { newCritical: 0, newWarnings: 0, stillOpen: 2, totalOpen: 2 },
  issues: [
    issue('warning', 'Image has no alt attribute.', '/', 'Images', false),
    issue('warning', 'Social sharing tags are missing (og:image).', '/about', 'SEO', false),
  ],
  isFirstCheck: false,
};

/** Spotless. */
export const spotless: ReportEmailData = {
  ...allClear,
  score: 100,
  previousScore: 100,
  warnings: 0,
  history: history([100, 100, 100, 100]),
  counts: { newCritical: 0, newWarnings: 0, stillOpen: 0, totalOpen: 0 },
  issues: [],
};

/** The first check of a website: no history and nothing to compare with. */
export const firstCheck: ReportEmailData = {
  ...attention,
  check: { ...CHECK, runNumber: 1 },
  score: 72,
  previousScore: null,
  critical: 2,
  warnings: 5,
  history: history([72]),
  counts: { newCritical: 2, newWarnings: 5, stillOpen: 0, totalOpen: 7 },
  issues: attention.issues.slice(0, 7).map((entry) => ({ ...entry, isNew: false })),
  isFirstCheck: true,
};

/** A check that could not run. */
export const failed: FailedEmailData = {
  ...COMMON,
  kind: 'failed',
  check: { runNumber: 8, finishedAt: '2026-09-28T06:00:41.000Z', trigger: 'Scheduled check' },
  reason:
    'Could not reach https://www.example-estates.co.uk/. The connection timed out after 20 seconds.',
  lastScore: 61,
};

export const FIXTURES = { attention, allClear, spotless, firstCheck, failed } as const;
export type FixtureName = keyof typeof FIXTURES;
