import { SCOPES, type ApiKey, type CreatedApiKey, type Scope } from '@qa-hub/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { keys } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { FieldError, Input, Label } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, EmptyState, ErrorState, describeError } from '@/components/ui/states';
import { formatDateTime, relativeTime } from '@/lib/format';

const SCOPE_HELP: Record<Scope, string> = {
  'scans:read': 'View scans, pages and issues',
  'scans:write': 'Start and cancel scans, ignore issues',
  'forms:submit': 'Let scans submit test data to forms',
};

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['scans:read', 'scans:write']);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const create = useMutation({
    mutationFn: () => api.apiKeys.create({ name: name.trim(), scopes }),
    onSuccess: (key) => {
      setCreated(key);
      void client.invalidateQueries({ queryKey: keys.apiKeys });
    },
  });

  function close(next: boolean): void {
    onOpenChange(next);
    if (!next) {
      setName('');
      setScopes(['scans:read', 'scans:write']);
      setCreated(null);
      create.reset();
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (name.trim() !== '' && scopes.length > 0) create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={created ? 'Copy your new API key' : 'Create an API key'}
        description={
          created
            ? undefined
            : 'Use a key for each integration, so you can revoke one without affecting the others.'
        }
      >
        {created ? (
          <div className="mt-4 space-y-4">
            <Alert tone="warning" title="This is the only time the key is shown">
              Store it now. QA Hub keeps only a fingerprint, so a lost key cannot be recovered.
              Create a new one instead.
            </Alert>
            <div>
              <Label htmlFor="new-key">API key</Label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id="new-key"
                  readOnly
                  value={created.key}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyButton
                  value={created.key}
                  label="Copy"
                  successMessage="API key copied"
                  size="md"
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="primary">I have saved it</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                className="mt-1.5"
                placeholder="n8n production"
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <fieldset>
              <legend className="text-[13px] font-medium text-fg">Permissions</legend>
              <div className="mt-2 space-y-2.5">
                {SCOPES.map((scope) => (
                  <div key={scope} className="flex items-start gap-2.5">
                    <Checkbox
                      id={`scope-${scope}`}
                      className="mt-0.5"
                      checked={scopes.includes(scope)}
                      onCheckedChange={(value) =>
                        setScopes(
                          value === true ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                        )
                      }
                    />
                    <Label htmlFor={`scope-${scope}`} className="font-normal">
                      <code className="text-xs">{scope}</code>
                      <span className="block text-xs text-muted">{SCOPE_HELP[scope]}</span>
                    </Label>
                  </div>
                ))}
              </div>
            </fieldset>
            {create.isError ? <FieldError>{describeError(create.error)}</FieldError> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                type="submit"
                variant="primary"
                loading={create.isPending}
                disabled={name.trim() === '' || scopes.length === 0}
              >
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKey | null; onClose: () => void }) {
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api.apiKeys.revoke(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.apiKeys });
      toast.success('API key revoked');
      onClose();
    },
    onError: (error) => toast.error(describeError(error)),
  });
  return (
    <Dialog open={apiKey !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Revoke this API key?"
        description={
          apiKey
            ? `Anything using "${apiKey.name}" stops working immediately. Past scans keep showing who started them.`
            : undefined
        }
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button>Keep key</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() => apiKey && revoke.mutate(apiKey.id)}
          >
            <Trash2 className="size-4" aria-hidden />
            Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysSection() {
  const list = useQuery({ queryKey: keys.apiKeys, queryFn: api.apiKeys.list });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const items = list.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Integrations such as n8n and CI authenticate with a key. Send it as{' '}
            <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>.
          </CardDescription>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden />
          Create key
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading API keys">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState
            title="Could not load API keys"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create a key to start scans from n8n, a CI pipeline or any script."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first key
              </Button>
            }
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">API keys</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-subtle">
                  <th scope="col" className="pb-2 pr-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium">
                    Key
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium">
                    Permissions
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium">
                    Last used
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((apiKey) => (
                  <tr key={apiKey.id} className="border-t border-border">
                    <td className="py-3 pr-3">
                      <span className="font-medium text-fg">{apiKey.name}</span>
                      <span className="block text-xs text-subtle">
                        Created {relativeTime(apiKey.createdAt)}
                        {apiKey.createdByName ? ` by ${apiKey.createdByName}` : ''}
                      </span>
                    </td>
                    <td className="py-3 pr-3">
                      <code className="text-xs text-muted">{apiKey.prefix}…</code>
                    </td>
                    <td className="py-3 pr-3">
                      <span className="flex flex-wrap gap-1">
                        {apiKey.scopes.map((scope) => (
                          <Badge key={scope} tone="outline">
                            {scope}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-[13px] text-muted">
                      {apiKey.revokedAt ? (
                        <Badge tone="critical">
                          <AlertTriangle className="size-3" aria-hidden />
                          Revoked
                        </Badge>
                      ) : apiKey.lastUsedAt ? (
                        <time
                          dateTime={apiKey.lastUsedAt}
                          title={formatDateTime(apiKey.lastUsedAt)}
                        >
                          {relativeTime(apiKey.lastUsedAt)}
                        </time>
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="py-3 text-right">
                      {apiKey.revokedAt ? null : (
                        <Button variant="ghost" size="sm" onClick={() => setRevoking(apiKey)}>
                          Revoke
                          <span className="sr-only"> {apiKey.name}</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}
