import type { CheckType } from '@qa-hub/shared';
import { imagesCheck } from './images.js';
import { linksCheck } from './links.js';
import { pageHealthCheck } from './page-health.js';
import { stagingUrlsCheck } from './staging-urls.js';
import type { Check } from './types.js';

/**
 * Every check the engine knows about. A new check is one file that exports a `Check`, plus one
 * line here. Checks listed in `CheckType` but not registered yet (`forms`, `seo`) are skipped.
 */
export const CHECKS: readonly Check[] = [
  imagesCheck,
  linksCheck,
  stagingUrlsCheck,
  pageHealthCheck,
];

export function checksFor(requested: readonly CheckType[]): Check[] {
  return CHECKS.filter((check) => requested.includes(check.id));
}

export type { Check } from './types.js';
