import { COLORS, scoreTone } from './theme.js';
import type { HistoryPoint } from './types.js';

const MIN_BAR = 4;
const MAX_BAR = 44;

/**
 * The height of a bar. The scale runs from a little below the lowest recent score up to 100, so a
 * drop from 91 to 61 is visible instead of squeezed into the top third of the chart.
 */
export function barHeight(score: number, floor = 0): number {
  const span = 100 - floor;
  const share = span <= 0 ? 1 : (Math.max(floor, Math.min(100, score)) - floor) / span;
  return Math.round(MIN_BAR + share * (MAX_BAR - MIN_BAR));
}

/** The lowest score the chart starts from: 20 below the lowest score shown, and never below 0. */
export function chartFloor(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  return Math.max(0, Math.min(...scores) - 20);
}

/** How many past checks the sparkline shows, including this one. */
export const SPARKLINE_MAX = 12;

/**
 * The last checks as a row of bars, built from table cells.
 *
 * SVG and data-URI images are stripped by Gmail and Outlook, and remote images are blocked by
 * default in many clients, so a chart made of images shows as a broken box for a lot of people. A
 * table of coloured cells renders everywhere, in Outlook too, because it only needs `height` and
 * `background-color` on cells. Older bars are grey and the latest is in its score colour.
 */
export function sparklineHtml(history: readonly HistoryPoint[]): string {
  const points = history.slice(-SPARKLINE_MAX);
  if (points.length < 2) return '';

  const floor = chartFloor(points.map((point) => point.score));
  const cells = points
    .map((point, index) => {
      const latest = index === points.length - 1;
      const height = barHeight(point.score, floor);
      const color = latest ? scoreTone(point.score).solid : '#d4d4d8';
      const label = `${point.at.slice(0, 10)}: ${point.score}`;
      return `<td valign="bottom" align="center" style="padding:0 3px;" title="${label}">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
          <tr><td height="${MAX_BAR - height}" style="height:${MAX_BAR - height}px;line-height:${MAX_BAR - height}px;font-size:1px;">&nbsp;</td></tr>
          <tr><td height="${height}" bgcolor="${color}" style="height:${height}px;line-height:${height}px;font-size:1px;background-color:${color};border-radius:3px 3px 0 0;">&nbsp;</td></tr>
        </table>
      </td>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
    <tr>${cells}</tr>
    <tr><td colspan="${points.length}" height="1" bgcolor="${COLORS.border}" style="height:1px;line-height:1px;font-size:1px;background-color:${COLORS.border};">&nbsp;</td></tr>
  </table>`;
}
