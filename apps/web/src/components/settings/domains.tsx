import type { AllowedDomain } from '@beacon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { keys } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { FieldError, FieldHint, Input, Label } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, describeError } from '@/components/ui/states';

export function DomainsSection() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: keys.domains, queryFn: api.domains.list });
  const [hostname, setHostname] = useState('');
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<AllowedDomain | null>(null);
  const items = list.data?.items ?? [];

  const add = useMutation({
    mutationFn: () =>
      api.domains.create({
        hostname: hostname.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (domain) => {
      void client.invalidateQueries({ queryKey: keys.domains });
      toast.success(`${domain.hostname} can now be scanned`);
      setHostname('');
      setNote('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.domains.remove(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.domains });
      toast.success('Domain removed');
      setRemoving(null);
    },
    onError: (error) => toast.error(describeError(error)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (hostname.trim() !== '') add.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Allowed domains</CardTitle>
          <CardDescription>
            Scans are only accepted for these hostnames. Start an entry with{' '}
            <code className="text-xs">*.</code> to include the domain and every subdomain.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="domain-host">Hostname</Label>
            <Input
              id="domain-host"
              className="mt-1.5 font-mono text-[13px]"
              placeholder="*.example.com"
              spellCheck={false}
              autoComplete="off"
              value={hostname}
              onChange={(event) => {
                setHostname(event.target.value);
                if (add.isError) add.reset();
              }}
              aria-invalid={add.isError || undefined}
              aria-describedby={add.isError ? 'domain-error' : undefined}
            />
          </div>
          <div>
            <Label htmlFor="domain-note">Note (optional)</Label>
            <Input
              id="domain-note"
              className="mt-1.5"
              placeholder="Client site and subdomains"
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={add.isPending}
            disabled={hostname.trim() === ''}
          >
            <Plus className="size-4" aria-hidden />
            Allow domain
          </Button>
        </form>
        {add.isError ? (
          <FieldError id="domain-error">{describeError(add.error)}</FieldError>
        ) : (
          <FieldHint>Enter a hostname only, without https:// or a path.</FieldHint>
        )}

        {list.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading allowed domains">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState
            title="Could not load allowed domains"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No domains allowed yet"
            description="Nobody can start a scan until at least one domain is on this list."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {items.map((domain) => (
              <li key={domain.id} className="flex items-center gap-3 px-4 py-2.5">
                <Globe className="size-4 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13px] text-fg">{domain.hostname}</p>
                  {domain.note ? (
                    <p className="truncate text-xs text-muted">{domain.note}</p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setRemoving(domain)}
                  aria-label={`Remove ${domain.hostname}`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent
          title="Remove this domain?"
          description={
            removing
              ? `New scans of ${removing.hostname} will be refused. Existing scans and reports are kept.`
              : undefined
          }
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Keep domain</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              Remove domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
