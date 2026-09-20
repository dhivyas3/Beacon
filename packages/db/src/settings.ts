import { CHECK_TYPES, FORM_MODES, type CheckType, type FormMode } from '@qa-hub/shared';
import { z } from 'zod';
import type { Db } from './index.js';

/** Scan defaults an admin can change at runtime. Stored in the `Setting` table. */
export interface StoredSettings {
  defaultChecks: CheckType[];
  defaultFormMode: FormMode;
  formTestEmail: string;
  stagingPatterns: string[];
}

const schemas = {
  defaultChecks: z.array(z.enum(CHECK_TYPES)).min(1),
  defaultFormMode: z.enum(FORM_MODES),
  formTestEmail: z.email(),
  stagingPatterns: z.array(z.string().min(1)),
} satisfies Record<keyof StoredSettings, z.ZodType>;

/** Saved values win. Anything missing or corrupt falls back to `defaults`. */
export async function loadStoredSettings(
  db: Db,
  defaults: StoredSettings,
): Promise<StoredSettings> {
  const rows = await db.setting.findMany();
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  function pick<K extends keyof StoredSettings>(key: K): StoredSettings[K] {
    const parsed = schemas[key].safeParse(stored.get(key));
    return parsed.success ? (parsed.data as StoredSettings[K]) : defaults[key];
  }

  return {
    defaultChecks: pick('defaultChecks'),
    defaultFormMode: pick('defaultFormMode'),
    formTestEmail: pick('formTestEmail'),
    stagingPatterns: pick('stagingPatterns'),
  };
}

export async function saveStoredSettings(db: Db, patch: Partial<StoredSettings>): Promise<void> {
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
}
