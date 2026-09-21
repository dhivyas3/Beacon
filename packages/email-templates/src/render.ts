import mjml2html from 'mjml';
import { sparklineHtml } from './sparkline.js';
import {
  buildPreheader,
  buildSubject,
  emailVariant,
  newIssueSummary,
  scoreChange,
  shortHost,
} from './subject.js';
import { buildText } from './text.js';
import { COLORS, FONT_STACK, scoreLabel, scoreTone, TONES, type Tone } from './theme.js';
import type {
  EmailData,
  EmailIssue,
  EmailVariant,
  FailedEmailData,
  RenderedEmail,
  ReportEmailData,
} from './types.js';

/** The most issues listed in the email. The rest are one click away in the report. */
export const MAX_ISSUES = 10;
/** A calm email lists fewer, since none of them are new. */
export const MAX_ISSUES_ALL_CLEAR = 5;

export function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A tinted, rounded box. MJML text blocks cannot have a background, so this is plain table markup. */
function notice(html: string, tone: Tone): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
    <tr><td bgcolor="${tone.soft}" style="background-color:${tone.soft};border-radius:8px;padding:14px 16px;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${tone.text};">${html}</td></tr>
  </table>`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${formatDate(iso)}, ${time} UTC`;
}

const BANNER: Record<EmailVariant, { tone: Tone; eyebrow: string }> = {
  all_clear: { tone: TONES.success, eyebrow: 'All clear' },
  attention: { tone: TONES.accent, eyebrow: 'Website health check' },
  failed: { tone: TONES.critical, eyebrow: 'Check could not run' },
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---- Pieces -------------------------------------------------------------------------------------

function brandRow(data: EmailData): string {
  return `
    <mj-section padding="24px 24px 12px">
      <mj-column width="55%" vertical-align="middle">
        <mj-text font-size="18px" font-weight="700" color="${COLORS.fg}" letter-spacing="-0.2px">
          <span style="color:${COLORS.accent};">&#9679;</span>&nbsp;Beacon
        </mj-text>
      </mj-column>
      <mj-column width="45%" vertical-align="middle">
        <mj-text align="right" font-size="12px" color="${COLORS.subtle}">
          ${esc(formatDate(data.check.finishedAt))}
        </mj-text>
      </mj-column>
    </mj-section>`;
}

function banner(data: EmailData, variant: EmailVariant): string {
  const { tone, eyebrow } = BANNER[variant];
  return `
    <mj-section background-color="${tone.solid}" border-radius="12px 12px 0 0" padding="24px 28px 22px">
      <mj-column>
        <mj-text font-size="11px" font-weight="700" letter-spacing="1.2px" color="#ffffff" text-transform="uppercase" padding-bottom="6px">
          ${esc(eyebrow)}
        </mj-text>
        <mj-text font-size="24px" font-weight="700" line-height="1.25" color="#ffffff" padding-bottom="4px">
          ${esc(data.website.name)}
        </mj-text>
        <mj-text font-size="13px" color="#ffffff">
          <a href="${esc(data.website.url)}" style="color:#ffffff;text-decoration:underline;">${esc(shortHost(data.website.hostname))}</a>
          &nbsp;·&nbsp;Check #${data.check.runNumber}&nbsp;·&nbsp;${esc(data.check.trigger)}
        </mj-text>
      </mj-column>
    </mj-section>`;
}

function greeting(data: EmailData, sentence: string): string {
  const name = data.recipient.name?.trim();
  const hello = name ? `Hi ${esc(name.split(/\s+/)[0] ?? name)},<br />` : '';
  return `
    <mj-section background-color="${COLORS.card}" padding="24px 28px 4px">
      <mj-column>
        <mj-text font-size="15px" line-height="1.55" color="${COLORS.fg}">${hello}${sentence}</mj-text>
      </mj-column>
    </mj-section>`;
}

/** A coloured ring with the score inside it. Where a client ignores rounded corners it is a square. */
function scoreBadge(score: number): string {
  const tone = scoreTone(score);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;border-spacing:0;">
      <tr>
        <td align="center" valign="middle" width="92" height="92"
            style="width:92px;height:92px;border:8px solid ${tone.solid};border-radius:50%;background-color:${tone.soft};font-family:${FONT_STACK};font-size:34px;font-weight:700;line-height:92px;color:${COLORS.fg};text-align:center;">
          ${score}
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:10px auto 0;">
      <tr>
        <td align="center" style="background-color:${tone.soft};border-radius:999px;padding:3px 12px;font-family:${FONT_STACK};font-size:12px;font-weight:700;color:${tone.text};">
          ${scoreLabel(score)} &middot; out of 100
        </td>
      </tr>
    </table>`;
}

function statTile(label: string, value: number, color: string): string {
  return `
      <mj-column background-color="${COLORS.surface2}" border-radius="8px" padding="14px 8px" inner-background-color="${COLORS.surface2}">
        <mj-text align="center" font-size="11px" font-weight="600" letter-spacing="0.6px" color="${COLORS.subtle}" text-transform="uppercase" padding="0 0 4px">${esc(label)}</mj-text>
        <mj-text align="center" font-size="28px" font-weight="700" line-height="1.1" color="${color}" padding="0">${value}</mj-text>
      </mj-column>`;
}

function scoreCard(data: ReportEmailData): string {
  return `
    <mj-section background-color="${COLORS.card}" padding="16px 20px 8px">
      <mj-column width="34%" vertical-align="middle" padding="8px 0">
        <mj-text padding="0">${scoreBadge(data.score)}</mj-text>
      </mj-column>
      <mj-group width="66%" vertical-align="middle">
        ${statTile('Pages checked', data.check.pagesChecked, COLORS.fg)}
        ${statTile('Critical', data.critical, data.critical > 0 ? COLORS.critical : COLORS.fg)}
        ${statTile('Warnings', data.warnings, data.warnings > 0 ? COLORS.warning : COLORS.fg)}
      </mj-group>
    </mj-section>
    <mj-section background-color="${COLORS.card}" padding="0 28px 0">
      <mj-column>
        <mj-text font-size="12px" color="${COLORS.subtle}" align="center" padding="6px 0 0">${esc(data.check.selection)}</mj-text>
      </mj-column>
    </mj-section>`;
}

function trendText(data: ReportEmailData): string {
  const change = scoreChange(data);
  if (change === null) {
    return `<span style="color:${COLORS.muted};">This is the first check of ${esc(data.website.name)}, so there is nothing to compare with yet.</span>`;
  }
  const tone = change > 0 ? TONES.success : change < 0 ? TONES.critical : null;
  const arrow = change > 0 ? '&#9650;' : change < 0 ? '&#9660;' : '&#9644;';
  const word = change === 0 ? 'No change' : `${change > 0 ? '+' : '&minus;'}${Math.abs(change)}`;
  return `<span style="color:${tone?.text ?? COLORS.muted};font-weight:700;">${arrow}&nbsp;${word}</span>
    <span style="color:${COLORS.muted};"> since the last check (was ${data.previousScore ?? '–'})</span>`;
}

function trend(data: ReportEmailData): string {
  const spark = sparklineHtml(data.history);
  const points = data.history.slice(-12);
  const caption =
    points.length >= 2
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;"><tr>
           <td align="left" style="font-family:${FONT_STACK};font-size:11px;color:${COLORS.subtle};">${esc(formatDate((points[0] as { at: string }).at))}</td>
           <td align="right" style="font-family:${FONT_STACK};font-size:11px;color:${COLORS.subtle};">Last ${points.length} checks &middot; ${esc(formatDate((points[points.length - 1] as { at: string }).at))}</td>
         </tr></table>`
      : '';
  return `
    <mj-section background-color="${COLORS.card}" padding="18px 28px 6px">
      <mj-column>
        <mj-text font-size="14px" line-height="1.5" padding="0 0 10px">${trendText(data)}</mj-text>
        ${spark === '' ? '' : `<mj-text padding="0">${spark}${caption}</mj-text>`}
      </mj-column>
    </mj-section>`;
}

function severityPill(severity: EmailIssue['severity']): string {
  const tone = severity === 'critical' ? TONES.critical : TONES.warning;
  return `<span style="display:inline-block;background-color:${tone.soft};color:${tone.text};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">${severity === 'critical' ? 'Critical' : 'Warning'}</span>`;
}

function issueRow(issue: EmailIssue, first: boolean): string {
  const tone = issue.severity === 'critical' ? TONES.critical : TONES.warning;
  const where = [
    issue.page === '' ? 'Whole site' : issue.page,
    ...(issue.pages > 1 ? [`and ${issue.pages - 1} other pages`] : []),
    issue.check,
  ]
    .map(esc)
    .join(' &middot; ');
  const isNew = issue.isNew
    ? `<span style="display:inline-block;background-color:${COLORS.accentSoft};color:${COLORS.accentText};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">New</span>`
    : '';
  return `
    <tr>
      <td width="4" style="width:4px;background-color:${issue.isNew ? tone.solid : COLORS.border};${first ? 'border-radius:4px 0 0 0;' : ''}">&nbsp;</td>
      <td valign="top" style="padding:12px 12px 12px 12px;border-bottom:1px solid ${COLORS.border};font-family:${FONT_STACK};">
        <div style="font-size:14px;line-height:1.4;font-weight:600;color:${COLORS.fg};">${esc(issue.message)}</div>
        <div style="font-size:12px;line-height:1.5;color:${COLORS.subtle};margin-top:3px;">${where}</div>
      </td>
      <td valign="top" align="right" style="padding:12px 0 12px 4px;border-bottom:1px solid ${COLORS.border};white-space:nowrap;font-family:${FONT_STACK};">
        ${severityPill(issue.severity)}${isNew === '' ? '' : `<div style="margin-top:4px;">${isNew}</div>`}
      </td>
    </tr>`;
}

function issuesSection(data: ReportEmailData, variant: EmailVariant): string {
  const limit = variant === 'all_clear' ? MAX_ISSUES_ALL_CLEAR : MAX_ISSUES;
  const shown = data.issues.slice(0, limit);
  const newTotal = data.counts.newCritical + data.counts.newWarnings;
  const hidden = data.counts.totalOpen - shown.length;

  if (data.counts.totalOpen === 0) {
    return `
    <mj-section background-color="${COLORS.card}" padding="18px 28px 6px">
      <mj-column>
        <mj-text padding="0">${notice('<strong>Nothing needs attention.</strong> The pages checked have no open issues.', TONES.success)}</mj-text>
      </mj-column>
    </mj-section>`;
  }

  const heading =
    newTotal > 0
      ? `New since the last check`
      : variant === 'all_clear' && !data.isFirstCheck
        ? 'Still open from earlier checks'
        : 'What was found';
  const sub =
    newTotal > 0
      ? newIssueSummary(data)
      : data.isFirstCheck
        ? `${plural(data.counts.totalOpen, 'issue', 'issues')} across the pages checked`
        : `Nothing new. ${plural(data.counts.stillOpen, 'issue is', 'issues are')} still open.`;
  const stillOpenLine =
    newTotal > 0 && data.counts.stillOpen > 0
      ? `<div style="margin-top:12px;font-size:13px;color:${COLORS.muted};">Also still open from earlier checks: <strong>${data.counts.stillOpen}</strong>.</div>`
      : '';
  const more =
    hidden > 0
      ? `<div style="margin-top:12px;font-size:13px;"><a href="${esc(data.links.report)}" style="color:${COLORS.accentText};font-weight:600;text-decoration:none;">View all ${data.counts.totalOpen} issues &rarr;</a></div>`
      : '';

  return `
    <mj-section background-color="${COLORS.card}" padding="20px 28px 4px">
      <mj-column>
        <mj-text font-size="16px" font-weight="700" color="${COLORS.fg}" padding="0 0 2px">${esc(heading)}</mj-text>
        <mj-text font-size="13px" color="${COLORS.muted}" padding="0 0 10px">${esc(sub)}</mj-text>
        <mj-text padding="0">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-top:1px solid ${COLORS.border};">
            ${shown.map((issue, index) => issueRow(issue, index === 0)).join('')}
          </table>
          ${stillOpenLine}${more}
        </mj-text>
      </mj-column>
    </mj-section>`;
}

function button(label: string, href: string, tone: Tone): string {
  return `
    <mj-section background-color="${COLORS.card}" padding="22px 28px 28px" border-radius="0 0 12px 12px">
      <mj-column>
        <mj-button href="${esc(href)}" background-color="${tone.solid}" color="#ffffff" font-size="15px" font-weight="700" border-radius="8px" inner-padding="13px 26px" padding="0" align="center">${esc(label)}</mj-button>
      </mj-column>
    </mj-section>`;
}

function footer(data: EmailData): string {
  const link = (href: string, text: string): string =>
    `<a href="${esc(href)}" style="color:${COLORS.muted};text-decoration:underline;">${esc(text)}</a>`;
  return `
    <mj-section padding="20px 24px 28px">
      <mj-column>
        <mj-text align="center" font-size="12px" line-height="1.7" color="${COLORS.subtle}">
          You are receiving this because ${esc(data.recipient.email)} is a recipient of the health reports for ${esc(data.website.name)}.<br />
          ${link(data.links.preferences, 'Manage email preferences')} &nbsp;·&nbsp;
          ${link(data.links.website, 'Change the schedule')} &nbsp;·&nbsp;
          ${link(data.links.unsubscribe, 'Unsubscribe')}
        </mj-text>
        <mj-text align="center" font-size="12px" color="${COLORS.subtle}" padding-top="10px">
          Beacon &middot; website health monitoring
        </mj-text>
      </mj-column>
    </mj-section>`;
}

// ---- Bodies -------------------------------------------------------------------------------------

function reportBody(data: ReportEmailData, variant: EmailVariant): string {
  const tone = BANNER[variant].tone;
  const lead =
    variant === 'all_clear'
      ? data.isFirstCheck
        ? `The first health check of <strong>${esc(data.website.name)}</strong> found nothing wrong.`
        : `Nothing new needs your attention on <strong>${esc(data.website.name)}</strong>. The score ${
            (scoreChange(data) ?? 0) > 0 ? 'improved' : 'held steady'
          }.`
      : data.isFirstCheck
        ? `Here is the first health check of <strong>${esc(data.website.name)}</strong>. It is the starting point that later checks are compared with.`
        : newIssueSummary(data) !== ''
          ? `The latest check of <strong>${esc(data.website.name)}</strong> found <strong>${esc(newIssueSummary(data))}</strong>.`
          : `The health score of <strong>${esc(data.website.name)}</strong> went down since the last check.`;

  return `
    ${banner(data, variant)}
    ${greeting(data, lead)}
    ${scoreCard(data)}
    ${trend(data)}
    ${issuesSection(data, variant)}
    ${button('View full report', data.links.report, tone)}`;
}

function failedBody(data: FailedEmailData): string {
  const last =
    data.lastScore === null
      ? ''
      : `<mj-text font-size="13px" color="${COLORS.muted}" padding="14px 0 0">The last check that completed scored <strong>${data.lastScore}</strong>.</mj-text>`;
  return `
    ${banner(data, 'failed')}
    ${greeting(data, `Beacon could not check <strong>${esc(data.website.name)}</strong> this time.`)}
    <mj-section background-color="${COLORS.card}" padding="16px 28px 8px">
      <mj-column>
        <mj-text padding="0">${notice(esc(data.reason), TONES.critical)}</mj-text>
        <mj-text font-size="14px" line-height="1.55" color="${COLORS.muted}" padding="14px 0 0">
          If the site was down, this is worth knowing about right away. The next scheduled check will run as normal, or you can start one from the dashboard once the site is back.
        </mj-text>
        ${last}
      </mj-column>
    </mj-section>
    ${button('View details', data.links.report, TONES.critical)}`;
}

/** Builds the MJML source for an email. Exported so the template can be inspected. */
export function buildMjml(data: EmailData, subject: string, preheader: string): string {
  const variant = emailVariant(data);
  const body = data.kind === 'failed' ? failedBody(data) : reportBody(data, variant);
  return `<mjml lang="en">
  <mj-head>
    <mj-title>${esc(subject)}</mj-title>
    <mj-preview>${esc(preheader)}</mj-preview>
    <mj-attributes>
      <mj-all font-family="${FONT_STACK}" />
      <mj-text font-size="14px" line-height="1.5" color="${COLORS.fg}" padding="0" />
      <mj-section padding="0" />
      <mj-column padding="0" />
    </mj-attributes>
    <mj-raw>
      <meta name="color-scheme" content="light only" />
      <meta name="supported-color-schemes" content="light only" />
    </mj-raw>
  </mj-head>
  <mj-body background-color="${COLORS.page}" width="600px">
    ${brandRow(data)}
    ${body}
    ${footer(data)}
  </mj-body>
</mjml>`;
}

/**
 * Renders the email for one recipient: subject, HTML and plain text. MJML turns the layout into
 * tables with inlined styles, which is what Outlook and Gmail need, and the build fails on any
 * markup MJML does not accept, so a broken template is caught by the tests, not by a recipient.
 */
export async function renderEmail(data: EmailData): Promise<RenderedEmail> {
  const subject = buildSubject(data);
  const preheader = buildPreheader(data);
  const { html, errors } = await mjml2html(buildMjml(data, subject, preheader), {
    validationLevel: 'strict',
    minify: false,
  });
  if (errors.length > 0) {
    throw new Error(
      `The email template is invalid: ${errors.map((e) => e.formattedMessage).join('; ')}`,
    );
  }
  return { subject, preheader, html, text: buildText(data), variant: emailVariant(data) };
}
