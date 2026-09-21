import {
  CHECK_LABELS,
  CHECK_TYPES,
  FORM_MODES,
  type CheckType,
  type FormMode,
} from '@qa-hub/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { keys, useSettings } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError, FieldHint, Input, Label, Select, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, describeError } from '@/components/ui/states';

const FORM_MODE_LABELS: Record<FormMode, string> = {
  detect: 'Detect only',
  validate_only: 'Validate only',
  submit: 'Submit test data',
};

function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Defaults for new scans. Only admins can change them. */
export function DefaultsSection({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const settings = useSettings();
  const [checks, setChecks] = useState<CheckType[]>([]);
  const [formMode, setFormMode] = useState<FormMode>('detect');
  const [email, setEmail] = useState('');
  const [patterns, setPatterns] = useState('');

  const data = settings.data;
  useEffect(() => {
    if (!data) return;
    setChecks(data.defaultChecks);
    setFormMode(data.defaultFormMode);
    setEmail(data.formTestEmail);
    setPatterns(data.stagingPatterns.join('\n'));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.settings.update({
        defaultChecks: checks,
        defaultFormMode: formMode,
        formTestEmail: email.trim(),
        stagingPatterns: parseList(patterns),
      }),
    onSuccess: (next) => {
      client.setQueryData(keys.settings, next);
      toast.success('Defaults saved');
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (canEdit && checks.length > 0) save.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Scan defaults</CardTitle>
          <CardDescription>
            Used when a scan does not say otherwise, including scans started from the API.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading defaults">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-9 w-64" />
          </div>
        ) : settings.isError ? (
          <ErrorState
            title="Could not load defaults"
            error={settings.error}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <form onSubmit={submit} className="max-w-2xl space-y-5">
            <fieldset disabled={!canEdit} className="space-y-5">
              <div>
                <legend className="text-[13px] font-medium text-fg">Checks</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {CHECK_TYPES.map((check) => {
                    return (
                      <div key={check} className="flex items-center gap-2.5">
                        <Checkbox
                          id={`default-${check}`}
                          checked={checks.includes(check)}
                          onCheckedChange={(value) =>
                            setChecks(
                              value === true
                                ? [...checks, check]
                                : checks.filter((c) => c !== check),
                            )
                          }
                        />
                        <Label htmlFor={`default-${check}`} className="font-normal">
                          {CHECK_LABELS[check]}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                {checks.length === 0 ? <FieldError>Pick at least one check.</FieldError> : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="default-form-mode">Form mode</Label>
                  <Select
                    id="default-form-mode"
                    className="mt-1.5 w-full"
                    value={formMode}
                    onChange={(event) => setFormMode(event.target.value as FormMode)}
                  >
                    {FORM_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {FORM_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="default-email">Test email for forms</Label>
                  <Input
                    id="default-email"
                    type="email"
                    className="mt-1.5"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="default-patterns">Staging host patterns</Label>
                <Textarea
                  id="default-patterns"
                  className="mt-1.5 font-mono text-[13px]"
                  rows={5}
                  spellCheck={false}
                  value={patterns}
                  onChange={(event) => setPatterns(event.target.value)}
                />
                <FieldHint>
                  One per line. <code className="text-xs">.netlify.app</code> matches a suffix,{' '}
                  <code className="text-xs">staging.</code> matches a leading label,{' '}
                  <code className="text-xs">localhost</code> matches that host.
                </FieldHint>
              </div>
            </fieldset>

            {save.isError ? <FieldError>{describeError(save.error)}</FieldError> : null}
            {canEdit ? (
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={checks.length === 0}
              >
                Save defaults
              </Button>
            ) : (
              <p className="text-[13px] text-muted">Only admins can change the defaults.</p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
