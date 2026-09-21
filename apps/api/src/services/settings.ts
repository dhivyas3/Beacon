import { loadStoredSettings, saveStoredSettings, type Db } from '@beacon/db';
import { type Settings, type UpdateSettingsBody } from '@beacon/shared';
import type { ApiConfig } from '../config.js';

function maskSecret(secret: string): string {
  return `${'•'.repeat(8)}${secret.slice(-4)}`;
}

/** Effective settings: values saved in the database override environment defaults. */
export async function loadSettings(db: Db, config: ApiConfig): Promise<Settings> {
  const stored = await loadStoredSettings(db, {
    defaultChecks: config.DEFAULT_CHECKS,
    defaultFormMode: 'detect',
    formTestEmail: config.FORM_TEST_EMAIL,
    stagingPatterns: config.STAGING_PATTERNS,
  });
  return {
    ...stored,
    webhookSecretPreview: maskSecret(config.WEBHOOK_SIGNING_SECRET),
    maxPages: config.MAX_PAGES,
    pageConcurrency: config.PAGE_CONCURRENCY,
  };
}

export async function updateSettings(
  db: Db,
  config: ApiConfig,
  patch: UpdateSettingsBody,
): Promise<Settings> {
  await saveStoredSettings(db, patch);
  return loadSettings(db, config);
}
