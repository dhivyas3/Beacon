import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/api/client';
import { keys, useSettings } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

/** The secret that signs callbacks. Masked until an admin chooses to reveal it. */
export function WebhooksSection() {
  const settings = useSettings();
  const [revealed, setRevealed] = useState(false);
  const secret = useQuery({
    queryKey: keys.webhookSecret,
    queryFn: api.settings.webhookSecret,
    enabled: revealed,
    staleTime: 0,
    gcTime: 0,
  });

  const shown =
    revealed && secret.data ? secret.data.secret : (settings.data?.webhookSecretPreview ?? '');

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Webhook signing secret</CardTitle>
          <CardDescription>
            When a scan finishes, QA Hub posts to the scan&apos;s{' '}
            <code className="text-xs">callbackUrl</code> with an{' '}
            <code className="text-xs">X-QAHub-Signature: sha256=&lt;hmac&gt;</code> header. Your
            receiver recomputes the HMAC-SHA256 of the raw body with this secret and compares.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.isPending ? (
          <Skeleton className="h-9 w-full max-w-md" />
        ) : settings.isError ? (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <>
            <div className="flex max-w-xl flex-wrap gap-2">
              <Input
                readOnly
                aria-label="Webhook signing secret"
                value={shown}
                className="min-w-0 flex-1 font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                onClick={() => setRevealed((value) => !value)}
                loading={revealed && secret.isPending}
                aria-pressed={revealed}
              >
                {revealed ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
              {revealed && secret.data ? (
                <CopyButton
                  value={secret.data.secret}
                  label="Copy"
                  successMessage="Secret copied"
                  size="md"
                />
              ) : null}
            </div>
            {secret.isError ? (
              <ErrorState error={secret.error} onRetry={() => void secret.refetch()} />
            ) : null}
            <p className="text-[13px] text-muted">
              The secret is set with the <code className="text-xs">WEBHOOK_SIGNING_SECRET</code>{' '}
              environment variable. To rotate it, change the variable and restart the API and
              worker, then update your receivers.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
