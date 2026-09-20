/** Queue names shared by producers (API) and consumers (worker). */
export const QUEUES = {
  scan: 'qahub-scan',
  callbacks: 'qahub-callbacks',
  maintenance: 'qahub-maintenance',
} as const;

export const REAPER_SCHEDULER_ID = 'reap-stale-scans';
export const REAPER_INTERVAL_MS = 30_000;
