import { z } from 'zod';
import { CHECK_TYPES, FORM_MODES } from '../constants.js';

export const SettingsSchema = z
  .object({
    defaultChecks: z.array(z.enum(CHECK_TYPES)).min(1),
    defaultFormMode: z.enum(FORM_MODES),
    formTestEmail: z.email(),
    webhookSecretPreview: z.string().describe('Masked. The full secret is set in the environment.'),
    maxPages: z.number().int(),
    pageConcurrency: z.number().int(),
    stagingPatterns: z.array(z.string()),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsBodySchema = z
  .object({
    defaultChecks: z.array(z.enum(CHECK_TYPES)).min(1).optional(),
    defaultFormMode: z.enum(FORM_MODES).optional(),
    formTestEmail: z.email().optional(),
    stagingPatterns: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .meta({ id: 'UpdateSettingsBody' });
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBodySchema>;
