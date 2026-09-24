import { CommonEnvSchema, parseEnv } from '@beacon/shared';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const WorkerEnvSchema = CommonEnvSchema.extend({
  /**
   * Some container runtimes refuse to let Chromium set up its own sandbox at all ("No usable
   * sandbox!"), which stops every scan before it starts. Turn this on only if you hit that exact
   * error; it is off by default everywhere, including on Railway, because it weakens isolation
   * against a page that exploits a Chromium bug. See docs/RAILWAY.md.
   */
  CHROMIUM_NO_SANDBOX: booleanFromString.default(false),
});
export type WorkerConfig = z.infer<typeof WorkerEnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseEnv(WorkerEnvSchema, env);
}
