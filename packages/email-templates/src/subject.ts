import type { EmailData, EmailVariant, ReportEmailData } from './types.js';

/** `www.example.com` is shown as `example.com`, which is how people say it. */
export function shortHost(hostname: string): string {
  return hostname.replace(/^www\./i, '');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Score minus the previous score, or null for a first check. */
export function scoreChange(data: ReportEmailData): number | null {
  return data.previousScore === null ? null : data.score - data.previousScore;
}

/**
 * Which design a recipient gets. The calm "all clear" one is for a check with nothing new to act
 * on and a score that held or improved. Anything else asks for attention. A first check has no
 * baseline, so it is all clear only when there is nothing wrong at all.
 */
export function emailVariant(data: EmailData): EmailVariant {
  if (data.kind === 'failed') return 'failed';
  const change = scoreChange(data);
  if (data.isFirstCheck) return data.critical + data.warnings === 0 ? 'all_clear' : 'attention';
  const nothingNew = data.counts.newCritical + data.counts.newWarnings === 0;
  return nothingNew && (change === null || change >= 0) ? 'all_clear' : 'attention';
}

/** Describes what is new, in the words used in the subject and the hero line. */
export function newIssueSummary(data: ReportEmailData): string {
  const parts: string[] = [];
  if (data.counts.newCritical > 0) {
    parts.push(plural(data.counts.newCritical, 'new critical issue', 'new critical issues'));
  }
  if (data.counts.newWarnings > 0) {
    parts.push(plural(data.counts.newWarnings, 'new warning', 'new warnings'));
  }
  return parts.join(', ');
}

/**
 * The subject says at a glance whether to open the email:
 *
 *   ✅ example-estates.co.uk — health score 94 (no new issues)
 *   ⚠️ example-estates.co.uk — health score 61 (3 new critical issues)
 */
export function buildSubject(data: EmailData): string {
  const host = shortHost(data.website.hostname);
  if (data.kind === 'failed') return `🚨 ${host} — the check could not run`;

  const variant = emailVariant(data);
  const icon = variant === 'all_clear' ? '✅' : '⚠️';
  const head = `${icon} ${host} — health score ${data.score}`;

  if (data.isFirstCheck) {
    if (variant === 'all_clear') return `${head} (first check, no issues)`;
    const found: string[] = [];
    if (data.critical > 0) found.push(plural(data.critical, 'critical issue', 'critical issues'));
    if (data.warnings > 0) found.push(plural(data.warnings, 'warning', 'warnings'));
    return `${head} (first check: ${found.join(', ')})`;
  }

  if (variant === 'all_clear') return `${head} (no new issues)`;

  const summary = newIssueSummary(data);
  if (summary !== '') return `${head} (${summary})`;
  const change = scoreChange(data) ?? 0;
  return `${head} (score down ${Math.abs(change)}, no new issues)`;
}

/** The hidden line after the subject in most inboxes. */
export function buildPreheader(data: EmailData): string {
  if (data.kind === 'failed') {
    return `${data.website.name} could not be checked: ${data.reason}`;
  }
  const change = scoreChange(data);
  const trend =
    change === null
      ? ''
      : change === 0
        ? ' Unchanged since the last check.'
        : ` ${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} since the last check.`;
  const summary = newIssueSummary(data);
  const lead =
    emailVariant(data) === 'all_clear'
      ? 'All clear. Nothing new needs your attention.'
      : summary !== ''
        ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`
        : `${plural(data.counts.totalOpen, 'issue needs', 'issues need')} your attention.`;
  return `${lead}${trend}`;
}
