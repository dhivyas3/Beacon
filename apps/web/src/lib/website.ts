import {
  describeSchedule,
  healthBand,
  normalizeUrl,
  type TriggerType,
  type Website,
} from '@beacon/shared';

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  manual_ui: 'Dashboard',
  manual_api: 'API',
  scheduled: 'Scheduled',
  n8n: 'n8n',
  monday: 'monday.com',
};

/** "Every page", "8 random pages, homepage always included", "3 chosen pages". */
export function describePageSelection(
  website: Pick<Website, 'pageSelectionMode' | 'sampleSize' | 'pinnedPageUrls' | 'staticPageUrls'>,
): string {
  switch (website.pageSelectionMode) {
    case 'full':
      return 'Every page';
    case 'static_list': {
      const count = website.staticPageUrls.length;
      return `${count} chosen ${count === 1 ? 'page' : 'pages'}`;
    }
    case 'random_sample': {
      const pinned = website.pinnedPageUrls.length;
      return (
        `${website.sampleSize} random ${website.sampleSize === 1 ? 'page' : 'pages'}, homepage always included` +
        (pinned > 0 ? `, plus ${pinned} pinned` : '')
      );
    }
  }
}

/**
 * The clock time in the viewer's time zone for an hour in UTC, such as "07:00 BST", or null when
 * it reads the same as UTC. Schedules are stored in UTC, and this is only a reading aid.
 */
export function localTimeOfUtcHour(
  hourUtc: number,
  at: Date = new Date(),
  timeZone?: string,
): string | null {
  const moment = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hourUtc),
  );
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(moment);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const clock = `${get('hour')}:${get('minute')}`;
  if (clock === `${String(hourUtc).padStart(2, '0')}:00`) return null;
  return `${clock} ${get('timeZoneName')}`.trim();
}

/** "Monthly on the 1st at 06:00 UTC (07:00 BST)". */
export function describeScheduleLocal(
  website: Pick<
    Website,
    'checkFrequency' | 'scheduleDayOfWeek' | 'scheduleDayOfMonth' | 'scheduleHourUtc'
  >,
  at: Date = new Date(),
  timeZone?: string,
): string {
  const text = describeSchedule(website);
  if (website.checkFrequency === 'manual') return text;
  const local = localTimeOfUtcHour(website.scheduleHourUtc, at, timeZone);
  return local ? `${text} (${local})` : text;
}

export interface ParsedUrls {
  urls: string[];
  invalid: string[];
}

/**
 * One address per line. A path such as "/contact" is taken to be on the website itself. Blank
 * lines are ignored and repeats collapse into one.
 */
export function parseUrlLines(text: string, siteUrl: string): ParsedUrls {
  const origin = originOf(siteUrl);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const candidate = line.startsWith('/') && origin ? `${origin}${line}` : line;
    const normal = normalizeUrl(candidate);
    if (normal === null) invalid.push(line);
    else if (!urls.includes(normal)) urls.push(normal);
  }
  return { urls, invalid };
}

function originOf(url: string): string | null {
  const normal = normalizeUrl(url);
  return normal === null ? null : new URL(normal).origin;
}

/** Sorting key for the overview: what needs attention comes first, paused websites last. */
export function attentionRank(website: Website): number {
  if (!website.isActive) return 5;
  if (website.latest?.healthScore === null || website.latest === null) return 4;
  const band = healthBand(website.latest.healthScore);
  return band === 'poor' ? 0 : band === 'fair' ? 1 : 3;
}

/** Whether the latest check found anything that needs someone's attention. */
export function needsAttention(website: Website): boolean {
  const latest = website.latest;
  if (!website.isActive || !latest || latest.healthScore === null) return false;
  return latest.critical > 0 || healthBand(latest.healthScore) === 'poor';
}
