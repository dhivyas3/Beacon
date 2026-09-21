export { renderEmail, buildMjml, MAX_ISSUES, MAX_ISSUES_ALL_CLEAR } from './render.js';
export {
  buildSubject,
  buildPreheader,
  emailVariant,
  newIssueSummary,
  scoreChange,
  shortHost,
} from './subject.js';
export { buildText } from './text.js';
export { sparklineHtml, barHeight, chartFloor, SPARKLINE_MAX } from './sparkline.js';
export { COLORS, FONT_STACK, scoreLabel, scoreTone } from './theme.js';
export type {
  EmailData,
  EmailIssue,
  EmailLinks,
  EmailVariant,
  FailedEmailData,
  HistoryPoint,
  RenderedEmail,
  ReportEmailData,
} from './types.js';
