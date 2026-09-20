/**
 * Health score: 100 - min(100, (critical * 5 + warnings * 1) / pagesTotal * 10), rounded.
 *
 * A site with no critical issues and no warnings scores 100. Each critical issue costs five
 * times as much as a warning, and the penalty is normalised by site size so a large site is not
 * punished for having more pages. A scan with zero pages is treated as one page.
 */
export function computeHealthScore(input: {
  critical: number;
  warnings: number;
  pagesTotal: number;
}): number {
  const pages = Math.max(1, input.pagesTotal);
  const penalty = Math.min(100, ((input.critical * 5 + input.warnings) / pages) * 10);
  return Math.round(100 - penalty);
}

export const HEALTH_SCORE_DESCRIPTION =
  'Starts at 100. Each critical issue costs 5 points and each warning costs 1, averaged across the pages scanned and multiplied by 10.';

export type HealthBand = 'good' | 'fair' | 'poor';

export function healthBand(score: number): HealthBand {
  if (score >= 90) return 'good';
  if (score >= 70) return 'fair';
  return 'poor';
}
