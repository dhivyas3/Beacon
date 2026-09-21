import { newIssueSummary, scoreChange, shortHost } from './subject.js';
import type { EmailData, ReportEmailData } from './types.js';

function date(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function trendLine(data: ReportEmailData): string {
  const change = scoreChange(data);
  if (change === null) return 'First check: nothing to compare with yet.';
  if (change === 0) return `No change since the last check (was ${data.previousScore}).`;
  return `${change > 0 ? '+' : '-'}${Math.abs(change)} since the last check (was ${data.previousScore}).`;
}

/** The plain-text alternative. Some clients show only this, and spam filters like having it. */
export function buildText(data: EmailData): string {
  const host = shortHost(data.website.hostname);
  const lines: string[] = ['Beacon', ''];

  if (data.kind === 'failed') {
    lines.push(
      `${data.website.name} (${host}) could not be checked`,
      `Check #${data.check.runNumber}, ${date(data.check.finishedAt)}`,
      '',
      data.reason,
      '',
    );
    if (data.lastScore !== null)
      lines.push(`The last check that completed scored ${data.lastScore}.`, '');
    lines.push(`View details: ${data.links.report}`);
  } else {
    lines.push(
      `${data.website.name} (${host})`,
      `Check #${data.check.runNumber}, ${date(data.check.finishedAt)}. ${data.check.trigger}. ${data.check.selection}.`,
      '',
      `Health score: ${data.score} / 100`,
      trendLine(data),
      '',
      `Pages checked: ${data.check.pagesChecked}`,
      `Critical issues: ${data.critical}`,
      `Warnings: ${data.warnings}`,
      '',
    );
    const summary = newIssueSummary(data);
    if (summary !== '') lines.push(`New since the last check: ${summary}.`);
    else if (!data.isFirstCheck) lines.push('Nothing new since the last check.');
    if (data.counts.stillOpen > 0)
      lines.push(`Still open from earlier checks: ${data.counts.stillOpen}.`);
    lines.push('');

    if (data.issues.length > 0) {
      lines.push('Issues:');
      for (const issue of data.issues.slice(0, 10)) {
        const where = [
          issue.page === '' ? 'whole site' : issue.page,
          ...(issue.pages > 1 ? [`and ${issue.pages - 1} other pages`] : []),
          issue.check,
        ].join(', ');
        lines.push(
          `- ${issue.isNew ? '[NEW] ' : ''}${issue.severity.toUpperCase()}: ${issue.message} (${where})`,
        );
      }
      if (data.counts.totalOpen > 10) {
        lines.push(`  ...and ${data.counts.totalOpen - 10} more.`);
      }
      lines.push('');
    }
    lines.push(`View the full report: ${data.links.report}`);
  }

  lines.push(
    '',
    '--',
    `You are receiving this because ${data.recipient.email} is a recipient of the health reports for ${data.website.name}.`,
    `Manage email preferences: ${data.links.preferences}`,
    `Change the schedule: ${data.links.website}`,
    `Unsubscribe: ${data.links.unsubscribe}`,
  );
  return lines.join('\n');
}
