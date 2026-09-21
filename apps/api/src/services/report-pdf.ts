import PDFDocument from 'pdfkit';
import type { ReportGroup } from './report-export.js';

export interface ReportPdfData {
  /** The website's name, or the hostname for a one-off scan. */
  title: string;
  url: string;
  runNumber: number;
  status: string;
  finishedAt: Date | null;
  healthScore: number | null;
  scoreChange: number | null;
  pages: number;
  critical: number;
  warnings: number;
  passed: number;
  checks: string[];
  kind: string;
  groups: ReportGroup[];
  omittedGroups: number;
}

const INK = '#101828';
const MUTED = '#667085';
const RULE = '#e4e7ec';
const CRITICAL = '#b42318';
const WARNING = '#b54708';
const GOOD = '#067647';

const EXTRA_CHARACTERS = new Set(['–', '—', '‘', '’', '“', '”', '…', '•', '€', '™']);

/**
 * The built-in PDF fonts only hold Latin-1 and a few typographic marks. Anything else, such as
 * an emoji in a scanned page's title, is shown as a question mark rather than as garbage.
 */
export function pdfSafe(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) out += ' ';
    else if ((code >= 32 && code < 127) || (code >= 160 && code <= 255)) out += character;
    else if (EXTRA_CHARACTERS.has(character)) out += character;
    else out += '?';
  }
  return out;
}

function scoreColor(score: number | null): string {
  if (score === null) return MUTED;
  if (score >= 90) return GOOD;
  if (score >= 70) return WARNING;
  return CRITICAL;
}

function describeChange(change: number | null): string | null {
  if (change === null) return null;
  if (change === 0) return 'No change since the last check';
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} since the last check`;
}

/** A one-page-or-more summary of a scan for people who do not open the dashboard. */
export function buildReportPdf(data: ReportPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      bufferPages: true,
      info: {
        Title: pdfSafe(`Beacon report: ${data.title}`),
        Author: 'Beacon',
        Subject: pdfSafe(data.url),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('BEACON  HEALTH REPORT', left);
    doc.moveDown(0.6);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(pdfSafe(data.title), { width });
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(pdfSafe(data.url), { width });
    const when = data.finishedAt
      ? data.finishedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : 'not finished';
    doc.text(pdfSafe(`Check ${data.runNumber} · ${data.kind} · ${data.status} · ${when}`), {
      width,
    });
    doc.moveDown(1);

    // Score and counts.
    const top = doc.y;
    doc
      .fillColor(scoreColor(data.healthScore))
      .font('Helvetica-Bold')
      .fontSize(44)
      .text(data.healthScore === null ? '-' : String(data.healthScore), left, top, {
        width: 110,
        lineBreak: false,
      });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    doc.text('Health score', left, top + 52, { width: 110, lineBreak: false });
    const change = describeChange(data.scoreChange);
    if (change) doc.text(change, left, top + 64, { width: 200, lineBreak: false });

    const tiles: [string, number, string][] = [
      ['Critical', data.critical, data.critical > 0 ? CRITICAL : INK],
      ['Warnings', data.warnings, data.warnings > 0 ? WARNING : INK],
      ['Pages checked', data.pages, INK],
      ['Passed', data.passed, INK],
    ];
    const tileWidth = 82;
    tiles.forEach(([label, value, color], index) => {
      const x = left + width - (tiles.length - index) * tileWidth;
      doc.fillColor(color).font('Helvetica-Bold').fontSize(22);
      doc.text(String(value), x, top + 8, { width: tileWidth - 8, lineBreak: false });
      doc.fillColor(MUTED).font('Helvetica').fontSize(9);
      doc.text(label, x, top + 38, { width: tileWidth - 8, lineBreak: false });
    });
    doc.y = top + 88;
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(RULE)
      .stroke();
    doc.moveDown(0.8);

    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    doc.text(pdfSafe(`Checks run: ${data.checks.join(', ')}`), left, doc.y, { width });
    doc.moveDown(1);

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Issues to fix', left, doc.y);
    doc.moveDown(0.5);

    if (data.groups.length === 0) {
      doc
        .fillColor(GOOD)
        .font('Helvetica')
        .fontSize(11)
        .text('No open critical issues or warnings. Nothing needs attention.', left, doc.y, {
          width,
        });
    }

    for (const group of data.groups) {
      const message = pdfSafe(group.message);
      const sub = pdfSafe(
        `${group.checkType} · ${group.affectedPages} ${group.affectedPages === 1 ? 'page' : 'pages'}` +
          (group.occurrences > group.affectedPages ? ` · ${group.occurrences} occurrences` : ''),
      );
      const urls = group.sampleUrls.map((url) => pdfSafe(url));
      doc.font('Helvetica').fontSize(10);
      const needed =
        doc.heightOfString(message, { width: width - 70 }) + 14 + urls.length * 11 + 12;
      if (doc.y + needed > bottom()) doc.addPage();

      const y = doc.y;
      const critical = group.severity === 'critical';
      doc
        .fillColor(critical ? CRITICAL : WARNING)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(critical ? 'CRITICAL' : 'WARNING', left, y + 2, { width: 62, lineBreak: false });
      doc
        .fillColor(INK)
        .font('Helvetica')
        .fontSize(10)
        .text(message, left + 70, y, {
          width: width - 70,
        });
      doc
        .fillColor(MUTED)
        .fontSize(8.5)
        .text(sub, left + 70, doc.y + 1, { width: width - 70 });
      for (const url of urls) {
        doc.text(url, left + 70, doc.y, { width: width - 70, lineBreak: false, ellipsis: true });
      }
      doc.y += 8;
    }

    if (data.omittedGroups > 0) {
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(9)
        .text(
          `${data.omittedGroups} more ${data.omittedGroups === 1 ? 'problem is' : 'problems are'} in the dashboard or the CSV export.`,
          left,
          doc.y + 4,
          { width },
        );
    }

    // Page numbers. The footer sits inside the bottom margin, so the margin is lowered while
    // writing it, or pdfkit would start a new page for it.
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      const margins = doc.page.margins;
      const originalBottom = margins.bottom;
      margins.bottom = 0;
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(8)
        .text(`Page ${index + 1} of ${range.count}`, left, doc.page.height - 30, {
          width,
          align: 'right',
          lineBreak: false,
        });
      margins.bottom = originalBottom;
    }
    doc.end();
  });
}
