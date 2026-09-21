/** Everything the report email needs, as plain data. The worker builds it, the template renders it. */

export interface EmailIssue {
  severity: 'critical' | 'warning';
  /** The label of the check, such as "Images". */
  check: string;
  /** The page's path, such as "/property/12-oak-lane". Empty for site-wide findings. */
  page: string;
  /** One line describing the problem. */
  message: string;
  /** How many pages have this same problem. The page above is the first of them. */
  pages: number;
  /** Not seen in the previous check. */
  isNew: boolean;
}

export interface HistoryPoint {
  score: number;
  /** ISO date of the check. */
  at: string;
}

export interface EmailLinks {
  /** The report for this check, in the app. */
  report: string;
  /** The website's page in the app, where the schedule is changed. */
  website: string;
  /** Where this recipient chooses what to be emailed about. */
  preferences: string;
  /** One click to stop the emails. Also sent as the List-Unsubscribe header. */
  unsubscribe: string;
}

interface Common {
  website: { name: string; url: string; hostname: string };
  recipient: { name: string | null; email: string };
  links: EmailLinks;
}

/** A check that completed. */
export interface ReportEmailData extends Common {
  kind: 'report';
  check: {
    runNumber: number;
    /** ISO time the check finished. */
    finishedAt: string;
    pagesChecked: number;
    /** How the pages were chosen, in words: "8 pages sampled", "All pages", "3 chosen pages". */
    selection: string;
    /** Where the check came from, in words: "Scheduled check", "Started by n8n". */
    trigger: string;
  };
  score: number;
  /** Score of the check before this one, or null for the first check. */
  previousScore: number | null;
  critical: number;
  warnings: number;
  /** Scores of the last checks, oldest first, ending with this one. */
  history: HistoryPoint[];
  counts: {
    newCritical: number;
    newWarnings: number;
    /** Open issues that were also in the previous check. */
    stillOpen: number;
    totalOpen: number;
  };
  /** New issues first, then the most severe still-open ones. At most ten are shown. */
  issues: EmailIssue[];
  isFirstCheck: boolean;
}

/** A check that could not run, such as a site that was down. */
export interface FailedEmailData extends Common {
  kind: 'failed';
  check: { runNumber: number; finishedAt: string; trigger: string };
  reason: string;
  /** The score of the last check that did complete, if there was one. */
  lastScore: number | null;
}

export type EmailData = ReportEmailData | FailedEmailData;

export type EmailVariant = 'all_clear' | 'attention' | 'failed';

export interface RenderedEmail {
  subject: string;
  /** The hidden line that many clients show after the subject. */
  preheader: string;
  html: string;
  text: string;
  variant: EmailVariant;
}
