import type { Db } from '@qa-hub/db';
import {
  CHECK_TYPES,
  FORM_MODES,
  type FormMode,
  type Settings,
  type UpdateSettingsBody,
} from '@qa-hub/shared';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';

const StoredSchemas = {
  defaultChecks: z.array(z.enum(CHECK_TYPES)).min(1),
  defaultFormMode: z.enum(FORM_MODES),
  formTestEmail: z.email(),
  stagingPatterns: z.array(z.string().min(1)),
} as const;

function maskSecret(secret: string): string {
  return `${'•'.repeat(8)}${secret.slice(-4)}`;
}

/** Effective settings: values saved in the database override environment defaults. */
export async function loadSettings(db: Db, config: ApiConfig): Promise<Settings> {
  const rows = await db.setting.findMany();
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  function pick<K extends keyof typeof StoredSchemas>(
    key: K,
    fallback: z.infer<(typeof StoredSchemas)[K]>,
  ): z.infer<(typeof StoredSchemas)[K]> {
    const parsed = StoredSchemas[key].safeParse(stored.get(key));
    return parsed.success ? (parsed.data as z.infer<(typeof StoredSchemas)[K]>) : fallback;
  }

  return {
    defaultChecks: pick('defaultChecks', config.DEFAULT_CHECKS),
    defaultFormMode: pick('defaultFormMode', 'detect' satisfies FormMode),
    formTestEmail: pick('formTestEmail', config.FORM_TEST_EMAIL),
    stagingPatterns: pick('stagingPatterns', config.STAGING_PATTERNS),
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
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  await db.$transaction(
    entries.map(([key, value]) =>
      db.setting.upsert({
        where: { key },
        create: { key, value: value },
        update: { value: value },
      }),
    ),
  );
  return loadSettings(db, config);
}
