/** Example payloads used in the OpenAPI document. Plain data, no dependencies. */

export const EXAMPLE_PROGRESS = {
  phase: 'running',
  percent: 41,
  pagesFound: 214,
  pagesDone: 87,
  pagesTotal: 214,
  linksChecked: 310,
  linksTotal: 1240,
  pagesPerMinute: 52,
  elapsedSeconds: 101,
  etaSeconds: 148,
  estimating: false,
  estimatedFinishAt: '2026-09-18T10:46:30.000Z',
  queuePosition: null,
} as const;

export const EXAMPLE_SCAN = {
  id: 'scn_a1B2c3D4e5F6',
  url: 'https://www.example-estates.co.uk/',
  hostname: 'www.example-estates.co.uk',
  runNumber: 7,
  status: 'running',
  checks: ['images', 'links', 'staging-urls', 'forms', 'page-health', 'seo'],
  formMode: 'detect',
  callbackUrl: 'https://n8n.example.com/webhook/beacon-callback',
  metadata: { mondayItemId: '1234567890' },
  progress: EXAMPLE_PROGRESS,
  summary: { healthScore: null, pages: 214, critical: 3, warnings: 11, passed: 60 },
  triggeredBy: { type: 'api_key', id: 'key_x9Y8w7V6u5T4', name: 'n8n production' },
  errorMessage: null,
  createdAt: '2026-09-18T10:42:40.000Z',
  startedAt: '2026-09-18T10:42:49.000Z',
  finishedAt: null,
  statusUrl: 'https://qa.example.com/api/v1/scans/scn_a1B2c3D4e5F6',
  reportUrl: 'https://qa.example.com/scans/scn_a1B2c3D4e5F6',
} as const;

export const EXAMPLE_ISSUE = {
  id: 'iss_Zk3Lm9Np2Qr8',
  scanId: 'scn_a1B2c3D4e5F6',
  pageId: 'pg_Ab12Cd34Ef56',
  pageUrl: 'https://www.example-estates.co.uk/properties/12-oak-lane',
  checkType: 'images',
  severity: 'critical',
  fingerprint: 'c4f1a9e27b03d5a1',
  message: 'Image failed to load (HTTP 404).',
  selector: 'main .gallery img:nth-of-type(3)',
  resourceUrl: 'https://www.example-estates.co.uk/media/oak-lane-3.jpg',
  evidence: { httpStatus: 404, naturalWidth: 0, alt: 'Front garden' },
  screenshotUrl:
    'https://qa.example.com/api/v1/scans/scn_a1B2c3D4e5F6/issues/iss_Zk3Lm9Np2Qr8/screenshot',
  state: 'open',
  ignoreNote: null,
  comparison: 'new',
  createdAt: '2026-09-18T10:43:12.000Z',
} as const;

export const EXAMPLE_API_KEY = {
  id: 'key_x9Y8w7V6u5T4',
  name: 'n8n production',
  prefix: 'bcn_7Hk2mP9x',
  scopes: ['scans:read', 'scans:write'],
  createdAt: '2026-09-01T09:00:00.000Z',
  lastUsedAt: '2026-09-18T10:42:40.000Z',
  revokedAt: null,
  createdByName: 'Dana Admin',
} as const;

export const EXAMPLE_ALLOWED_DOMAIN = {
  id: 'dom_Qw3Er5Ty7Ui9',
  hostname: '*.example-estates.co.uk',
  note: 'Client site and subdomains',
  createdAt: '2026-09-01T09:00:00.000Z',
  createdByName: 'Dana Admin',
} as const;
