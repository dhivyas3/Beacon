import type { CheckType } from '@qa-hub/shared';
import { formsCheck } from './forms.js';
import { imagesCheck } from './images.js';
import { linksCheck } from './links.js';
import { pageHealthCheck } from './page-health.js';
import { seoCheck } from './seo.js';
import { stagingUrlsCheck } from './staging-urls.js';
import type { Check } from './types.js';

/**
 * Every check the engine knows about. A new check is one file that exports a `Check`, plus one
 * line here. Every `CheckType` has a check.
 */
export const CHECKS: readonly Check[] = [
  imagesCheck,
  linksCheck,
  stagingUrlsCheck,
  pageHealthCheck,
  formsCheck,
  seoCheck,
];

export function checksFor(requested: readonly CheckType[]): Check[] {
  return CHECKS.filter((check) => requested.includes(check.id));
}

export type { Check } from './types.js';
