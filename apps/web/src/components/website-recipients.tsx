import { NOTIFY_PREFERENCES, type NotifyPreference, type Website } from '@beacon/shared';
import { Mail, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ApiClientError } from '@/api/client';
import { useRecipientActions, useUpdateWebsite } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError, Input, Label, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/states';

const NOTIFY_LABELS: Record<NotifyPreference, string> = {
  every_check: 'Every report',
  new_issues_only: 'Only when something is new',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failure(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

/** Who gets the report: add, pause, change what they receive, remove. Every change is saved at once. */
export function RecipientsCard({ website }: { website: Website }) {
  const actions = useRecipientActions(website.id);
  const update = useUpdateWebsite(website.id);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function add(event: FormEvent): void {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setProblem('Enter a valid email address.');
      return;
    }
    setProblem(null);
    actions.add.mutate(
      { email: address, name: name.trim() === '' ? null : name.trim() },
      {
        onSuccess: () => {
          setEmail('');
          setName('');
          toast.success(`${address} added`);
        },
        onError: (error) => setProblem(failure(error, 'Could not add the recipient.')),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Recipients</CardTitle>
          <CardDescription>
            Each person can also change what they receive from the link in every email.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!website.emailEnabled ? (
          <Alert
            tone="warning"
            title="Emails are turned off for this website"
            action={
              <Button
                size="sm"
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    { emailEnabled: true },
                    { onSuccess: () => toast.success('Emails turned on') },
                  )
                }
              >
                Turn on
              </Button>
            }
          >
            Recipients are kept, but nothing is sent after a check.
          </Alert>
        ) : null}

        {website.recipients.length === 0 ? (
          <p className="text-[13px] text-muted">
            No recipients yet. Add an address to start emailing reports.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {website.recipients.map((recipient) => (
              <li
                key={recipient.id}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 py-2.5 first:pt-0"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 break-all text-[13px] font-medium text-fg">
                    {recipient.email}
                    {!recipient.isActive ? <Badge tone="neutral">Paused</Badge> : null}
                  </p>
                  {recipient.name ? <p className="text-xs text-muted">{recipient.name}</p> : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="col-start-2 row-start-1"
                  aria-label={`Remove ${recipient.email}`}
                  onClick={() =>
                    actions.remove.mutate(recipient.id, {
                      onSuccess: () => toast.success(`${recipient.email} removed`),
                      onError: (error) =>
                        toast.error(failure(error, 'Could not remove the recipient.')),
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
                <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div>
                    <Label htmlFor={`notify-${recipient.id}`} className="sr-only">
                      What {recipient.email} receives
                    </Label>
                    <Select
                      id={`notify-${recipient.id}`}
                      value={recipient.notify}
                      className="h-8 text-[13px]"
                      onChange={(event) =>
                        actions.update.mutate(
                          {
                            recipientId: recipient.id,
                            body: { notify: event.target.value as NotifyPreference },
                          },
                          {
                            onError: (error) =>
                              toast.error(failure(error, 'Could not change the recipient.')),
                          },
                        )
                      }
                    >
                      {NOTIFY_PREFERENCES.map((preference) => (
                        <option key={preference} value={preference}>
                          {NOTIFY_LABELS[preference]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`active-${recipient.id}`}
                      checked={recipient.isActive}
                      onCheckedChange={(value) =>
                        actions.update.mutate(
                          { recipientId: recipient.id, body: { isActive: value === true } },
                          {
                            onError: (error) =>
                              toast.error(failure(error, 'Could not change the recipient.')),
                          },
                        )
                      }
                    />
                    <Label htmlFor={`active-${recipient.id}`}>Receives emails</Label>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={add}
          noValidate
          aria-label="Add a recipient"
          className="border-t border-border pt-4"
        >
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <Label htmlFor="new-recipient-email" className="sr-only">
                Email address
              </Label>
              <Input
                id="new-recipient-email"
                type="email"
                placeholder="Email address"
                autoComplete="off"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (problem) setProblem(null);
                }}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? 'new-recipient-error' : undefined}
              />
            </div>
            <div>
              <Label htmlFor="new-recipient-name" className="sr-only">
                Name (optional)
              </Label>
              <Input
                id="new-recipient-name"
                placeholder="Name (optional)"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" loading={actions.add.isPending}>
              <Plus className="size-4" aria-hidden />
              Add recipient
            </Button>
          </div>
          {problem ? <FieldError id="new-recipient-error">{problem}</FieldError> : null}
        </form>
      </CardContent>
    </Card>
  );
}

export function NoRecipientsHint() {
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-muted">
      <Mail className="size-3.5" aria-hidden />
      No one is emailed yet.
    </p>
  );
}
