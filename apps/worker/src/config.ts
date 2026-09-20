import { CommonEnvSchema, parseEnv } from '@qa-hub/shared';
import type { z } from 'zod';

export const WorkerEnvSchema = CommonEnvSchema;
export type WorkerConfig = z.infer<typeof WorkerEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(WorkerEnvSchema, env);
}
