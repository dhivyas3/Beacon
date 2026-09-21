// Runs a command with the repository's root .env loaded, so `pnpm db:migrate` and `pnpm db:seed`
// work straight after `cp .env.example .env`. Variables already set in the environment win, which
// is what CI and Docker rely on.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}
const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
