import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CHECK_LABELS,
  CHECK_TYPES,
  FORM_MODES,
  type CheckType,
  type FormMode,
} from '@qa-hub/shared';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import { forwardRef, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError, api } from '@/api/client';
import { useSettings } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError, Input, Label } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { parseScanUrl } from '@/lib/format';

/** Checks the worker does not run yet. They are listed so the list is complete, but cannot be picked. */
export const UNAVAILABLE_CHECKS: readonly CheckType[] = ['forms', 'seo'];

const FORM_MODE_LABELS: Record<FormMode, { label: string; hint: string }> = {
  detect: { label: 'Detect only', hint: 'Record forms and fields. Nothing is sent.' },
  validate_only: {
    label: 'Validate only',
    hint: 'Submit empty and invalid data and check the messages. Nothing reaches the server.',
  },
  submit: {
    label: 'Submit test data',
    hint: 'Send clearly marked test data and check the success state.',
  },
};

function availableChecks(checks: readonly CheckType[]): CheckType[] {
  return checks.filter((check) => !UNAVAILABLE_CHECKS.includes(check));
}

/** The "New scan" box: a URL, and options for which checks to run and how to treat forms. */
export const NewScanForm = forwardRef<HTMLInputElement>(function NewScanForm(_props, forwardedRef) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const settings = useSettings();
  const errorId = useId();
  const localRef = useRef<HTMLInputElement>(null);

  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [existingScan, setExistingScan] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckType[] | null>(null);
  const [formMode, setFormMode] = useState<FormMode | null>(null);

  // Start from the saved defaults until the person changes something.
  const effectiveChecks = checks ?? availableChecks(settings.data?.defaultChecks ?? CHECK_TYPES);
  const effectiveFormMode = formMode ?? settings.data?.defaultFormMode ?? 'detect';

  const idempotencyKey = useRef<string>(crypto.randomUUID());
  useEffect(() => {
    idempotencyKey.current = crypto.randomUUID();
  }, [url]);

  const create = useMutation({
    mutationFn: (target: string) =>
      api.scans.create(
        { url: target, checks: effectiveChecks, formMode: effectiveFormMode },
        idempotencyKey.current,
      ),
    onSuccess: (scan) => {
      void client.invalidateQueries({ queryKey: ['scans'] });
      toast.success('Scan started');
      setUrl('');
      void navigate(`/scans/${scan.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === 'conflict') {
        const existing = (error.details as { scan?: { id?: string } } | undefined)?.scan?.id;
        setExistingScan(existing ?? null);
      }
      setProblem(
        error instanceof ApiClientError
          ? error.message
          : 'The scan could not be started. Try again.',
      );
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setExistingScan(null);
    const target = parseScanUrl(url);
    if (target === null) {
      setProblem('Enter a full site address, for example https://www.example.com.');
      localRef.current?.focus();
      return;
    }
    if (effectiveChecks.length === 0) {
      setProblem('Pick at least one check to run.');
      return;
    }
    setProblem(null);
    create.mutate(target);
  }

  function toggle(check: CheckType, on: boolean): void {
    setChecks(on ? [...effectiveChecks, check] : effectiveChecks.filter((item) => item !== check));
  }

  const customised =
    checks !== null ||
    (formMode !== null && formMode !== (settings.data?.defaultFormMode ?? 'detect'));

  return (
    <form onSubmit={submit} noValidate aria-label="Start a new scan">
      <Label htmlFor="scan-url" className="sr-only">
        Site address
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Input
            id="scan-url"
            ref={(node) => {
              localRef.current = node;
              if (typeof forwardedRef === 'function') forwardedRef(node);
              else if (forwardedRef) forwardedRef.current = node;
            }}
            type="url"
            inputMode="url"
            placeholder="https://www.example.com"
            autoComplete="off"
            spellCheck={false}
            className="h-11 pr-3 font-mono text-[13px]"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (problem) setProblem(null);
            }}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem ? errorId : undefined}
          />
        </div>
        <div className="flex gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button size="lg" aria-label="Scan options" className="flex-1 sm:flex-none">
                <SlidersHorizontal className="size-4" aria-hidden />
                Options
                {customised ? (
                  <span className="size-1.5 rounded-full bg-accent" aria-label="customised" />
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="end">
              <fieldset>
                <legend className="text-[13px] font-semibold text-fg">Checks</legend>
                <div className="mt-2 space-y-2">
                  {CHECK_TYPES.map((check) => {
                    const unavailable = UNAVAILABLE_CHECKS.includes(check);
                    const id = `check-${check}`;
                    return (
                      <div key={check} className="flex items-center gap-2.5">
                        <Checkbox
                          id={id}
                          checked={!unavailable && effectiveChecks.includes(check)}
                          disabled={unavailable}
                          onCheckedChange={(value) => toggle(check, value === true)}
                        />
                        <Label htmlFor={id} className={unavailable ? 'text-subtle' : undefined}>
                          {CHECK_LABELS[check]}
                        </Label>
                        {unavailable ? <Badge tone="outline">Soon</Badge> : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset className="mt-4 border-t border-border pt-4">
                <legend className="text-[13px] font-semibold text-fg">Forms</legend>
                <div className="mt-2 space-y-2.5">
                  {FORM_MODES.map((mode) => (
                    <label key={mode} className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="radio"
                        name="form-mode"
                        value={mode}
                        checked={effectiveFormMode === mode}
                        onChange={() => setFormMode(mode)}
                        className="mt-1 accent-[var(--accent)]"
                      />
                      <span>
                        <span className="block text-[13px] font-medium text-fg">
                          {FORM_MODE_LABELS[mode].label}
                        </span>
                        <span className="block text-xs text-muted">
                          {FORM_MODE_LABELS[mode].hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </PopoverContent>
          </Popover>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={create.isPending}
            className="flex-1 sm:flex-none"
          >
            New scan
            <ArrowRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      {problem ? (
        <div className="mt-2">
          <FieldError id={errorId}>
            {problem}
            {existingScan ? (
              <>
                {' '}
                <Link
                  to={`/scans/${existingScan}`}
                  className="font-medium underline underline-offset-2"
                >
                  View that scan
                </Link>
              </>
            ) : null}
          </FieldError>
        </div>
      ) : null}
    </form>
  );
});
