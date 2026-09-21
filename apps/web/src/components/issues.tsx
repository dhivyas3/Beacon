import type { Issue } from '@beacon/shared';
import { Ban, ChevronDown, ExternalLink, EyeOff, Maximize2, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useUpdateIssue } from '@/api/hooks';
import { CheckBadge, ComparisonBadge, SeverityLabel } from '@/components/severity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { pathOf } from '@/lib/format';

/** Screenshots are served by the API. Use the path so it works whatever host the app is on. */
export function screenshotSrc(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The parts of an issue's evidence a person wants to read, in order of usefulness. */
export function summariseEvidence(issue: Issue): {
  httpStatus: number | null;
  excerpt: string | null;
  rule: string | null;
  rest: Record<string, unknown>;
} {
  const evidence = issue.evidence;
  const { rule, httpStatus, text, message, failure, error, ...rest } = evidence;
  const errorText =
    typeof error === 'object' && error !== null
      ? textOf((error as { message?: unknown }).message)
      : textOf(error);
  return {
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
    excerpt: textOf(text) ?? textOf(message) ?? textOf(failure) ?? errorText,
    rule: textOf(rule),
    rest,
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[130px_1fr] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">{children}</dd>
    </div>
  );
}

function IgnoreDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Ignore this issue"
        description="It stays in the report but no longer counts towards the health score. Add a note so others know why."
      >
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(note.trim());
            setNote('');
          }}
        >
          <Label htmlFor="ignore-note">Note (optional)</Label>
          <Textarea
            id="ignore-note"
            className="mt-1.5"
            placeholder="For example: known, tracked in MON-1042"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary">
              <EyeOff className="size-4" aria-hidden />
              Ignore issue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Screenshot({ issue }: { issue: Issue }) {
  if (!issue.screenshotUrl) return null;
  const src = screenshotSrc(issue.screenshotUrl);
  return (
    <Dialog>
      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Screenshot</p>
        <DialogTrigger
          className="relative block overflow-hidden rounded-md transition-opacity hover:opacity-90"
          aria-label="Enlarge screenshot"
        >
          <img
            src={src}
            alt="Screenshot of the problem"
            loading="lazy"
            className="h-32 w-auto max-w-full rounded-md border border-border object-cover object-top"
          />
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
            <Maximize2 className="size-3" aria-hidden />
            Enlarge
          </span>
        </DialogTrigger>
      </div>
      <DialogContent title="Screenshot" description="The element is outlined in red." wide>
        <img
          src={src}
          alt="Screenshot of the page with the problem element outlined in red"
          className="mt-4 max-h-[75dvh] w-full rounded-md border border-border object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Everything known about one occurrence of an issue, with the actions to ignore or reopen it. */
export function EvidencePanel({ issue, scanId }: { issue: Issue; scanId: string }) {
  const update = useUpdateIssue(scanId);
  const [ignoring, setIgnoring] = useState(false);
  const { httpStatus, excerpt, rule, rest } = summariseEvidence(issue);
  const hasRest = Object.keys(rest).length > 0;

  function setState(state: Issue['state'], note?: string): void {
    update.mutate(
      { issueId: issue.id, state, ignoreNote: note ?? null },
      {
        onSuccess: () => {
          if (state === 'ignored') {
            toast('Issue ignored', {
              action: {
                label: 'Undo',
                onClick: () => update.mutate({ issueId: issue.id, state: 'open' }),
              },
            });
          } else {
            toast.success('Issue reopened');
          }
        },
        onError: () => toast.error('Could not update the issue. Try again.'),
      },
    );
  }

  return (
    <div className="border-t border-border bg-surface-2/50 px-4 py-4 sm:pl-11">
      <dl className="space-y-2.5">
        {issue.pageUrl ? (
          <Field label="Page">
            <a
              href={issue.pageUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-accent-text hover:underline"
            >
              {issue.pageUrl}
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          </Field>
        ) : null}
        {issue.selector ? (
          <Field label="Element">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                {issue.selector}
              </code>
              <CopyButton
                value={issue.selector}
                iconOnly
                variant="ghost"
                label="Copy selector"
                successMessage="Selector copied"
              />
            </span>
          </Field>
        ) : null}
        {issue.resourceUrl ? (
          <Field label="Resource">
            <a
              href={issue.resourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-accent-text hover:underline"
            >
              {issue.resourceUrl}
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          </Field>
        ) : null}
        {httpStatus !== null ? (
          <Field label="HTTP status">
            <span className="tabular font-mono text-xs">{httpStatus}</span>
          </Field>
        ) : null}
        {excerpt ? (
          <Field label="Excerpt">
            <pre className="scroll-x whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2.5 font-mono text-xs leading-relaxed text-muted">
              {excerpt}
            </pre>
          </Field>
        ) : null}
        {rule ? (
          <Field label="Rule">
            <code className="text-xs text-muted">{rule}</code>
          </Field>
        ) : null}
        {issue.state === 'ignored' ? (
          <Field label="Ignored">
            <span className="text-muted">{issue.ignoreNote ?? 'No note'}</span>
          </Field>
        ) : null}
      </dl>

      {hasRest ? (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-muted hover:text-fg">More details</summary>
          <pre className="scroll-x mt-2 rounded-md border border-border bg-surface p-2.5 font-mono text-xs text-muted">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </details>
      ) : null}

      <Screenshot issue={issue} />

      <div className="mt-4 flex flex-wrap gap-2">
        {issue.state === 'ignored' ? (
          <Button size="sm" loading={update.isPending} onClick={() => setState('open')}>
            <RotateCcw className="size-3.5" aria-hidden />
            Reopen
          </Button>
        ) : (
          <Button size="sm" onClick={() => setIgnoring(true)}>
            <EyeOff className="size-3.5" aria-hidden />
            Ignore
          </Button>
        )}
      </div>
      <IgnoreDialog
        open={ignoring}
        onOpenChange={setIgnoring}
        onConfirm={(note) => {
          setIgnoring(false);
          setState('ignored', note);
        }}
      />
    </div>
  );
}

/** One issue in a list. Click to see its evidence. */
export function IssueRow({
  issue,
  scanId,
  showPage = false,
}: {
  issue: Issue;
  scanId: string;
  /** Show the page it was found on, for lists that are not already grouped by page. */
  showPage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ignored = issue.state === 'ignored';
  return (
    <li className={cn('border-b border-border last:border-b-0', ignored && 'opacity-70')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60"
      >
        <SeverityLabel severity={issue.severity} iconOnly className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{issue.message}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <CheckBadge checkType={issue.checkType} />
            <ComparisonBadge comparison={issue.comparison} />
            {ignored ? (
              <Badge tone="neutral">
                <Ban className="size-3" aria-hidden />
                Ignored
              </Badge>
            ) : null}
            {showPage && issue.pageUrl ? (
              <span className="truncate font-mono text-xs text-subtle">
                {pathOf(issue.pageUrl)}
              </span>
            ) : null}
            {!showPage && (issue.resourceUrl ?? issue.selector) ? (
              <span className="min-w-0 max-w-full truncate font-mono text-xs text-subtle">
                {issue.resourceUrl ?? issue.selector}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'mt-1 size-4 shrink-0 text-subtle transition-transform duration-150',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open ? <EvidencePanel issue={issue} scanId={scanId} /> : null}
    </li>
  );
}
