import { healthBand, type HealthBand } from '@beacon/shared';

/** The dashboard's light palette, so an email and the app look like one product. */
export const COLORS = {
  page: '#f4f4f5',
  card: '#ffffff',
  surface2: '#f4f4f5',
  border: '#e4e4e7',
  fg: '#18181b',
  muted: '#52525b',
  subtle: '#71717a',
  accent: '#4f46e5',
  accentSoft: '#eef2ff',
  accentText: '#4338ca',
  critical: '#dc2626',
  criticalSoft: '#fef2f2',
  criticalText: '#b91c1c',
  warning: '#d97706',
  warningSoft: '#fffbeb',
  warningText: '#92400e',
  success: '#16a34a',
  successSoft: '#f0fdf4',
  successText: '#15803d',
} as const;

/**
 * Web-safe fallbacks after Inter, because most clients will not have it. Roboto is left out on
 * purpose: MJML answers a named web font by linking to Google Fonts, a remote load that is blocked
 * by some clients and tells a third party when the email is opened. Android falls back to its own
 * sans-serif, which is Roboto anyway.
 */
export const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface Tone {
  solid: string;
  soft: string;
  text: string;
}

export const TONES: Record<'success' | 'warning' | 'critical' | 'accent', Tone> = {
  success: { solid: COLORS.success, soft: COLORS.successSoft, text: COLORS.successText },
  warning: { solid: COLORS.warning, soft: COLORS.warningSoft, text: COLORS.warningText },
  critical: { solid: COLORS.critical, soft: COLORS.criticalSoft, text: COLORS.criticalText },
  accent: { solid: COLORS.accent, soft: COLORS.accentSoft, text: COLORS.accentText },
};

const BAND_TONE: Record<HealthBand, Tone> = {
  good: TONES.success,
  fair: TONES.warning,
  poor: TONES.critical,
};

const BAND_LABEL: Record<HealthBand, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };

/** The same bands as the dashboard: 90 and above is good, 70 and above is fair. */
export function scoreTone(score: number): Tone {
  return BAND_TONE[healthBand(score)];
}

export function scoreLabel(score: number): string {
  return BAND_LABEL[healthBand(score)];
}
