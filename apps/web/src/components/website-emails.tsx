import type { DeliveryStatus } from '@beacon/shared';
import { Link } from 'react-router';
import { useEmailDeliveries } from '@/api/hooks';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { relativeTime } from '@/lib/format';

const STATUS: Record<DeliveryStatus, { label: string; tone: NonNullable<BadgeProps['tone']> }> = {
  sent: { label: 'Sent', tone: 'success' },
  pending: { label: 'Sending', tone: 'accent' },
  failed: { label: 'Failed', tone: 'critical' },
  skipped: { label: 'Not sent', tone: 'outline' },
};

/** What was emailed for this website, and why anything was not. A failed email shows up here. */
export function EmailDeliveriesCard({ websiteId }: { websiteId: string }) {
  const deliveries = useEmailDeliveries(websiteId);
  const items = deliveries.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Emails</CardTitle>
          <CardDescription>
            The report emails sent after each check, and the reason when one was not sent.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {deliveries.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading emails">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : deliveries.isError ? (
          <ErrorState
            title="Could not load emails"
            error={deliveries.error}
            onRetry={() => void deliveries.refetch()}
          />
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted">
            No emails yet. The first one is sent when a check completes.
          </p>
        ) : (
          <>
            <div className="scroll-x">
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <caption className="sr-only">Report emails, newest first</caption>
                <thead>
                  <tr className="text-left text-xs font-medium uppercase tracking-wide text-subtle">
                    <th scope="col" className="py-2 pr-3">
                      Recipient
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Check
                    </th>
                    <th scope="col" className="py-2">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((delivery) => {
                    const status = STATUS[delivery.status];
                    return (
                      <tr key={delivery.id} className="border-t border-border align-top">
                        <td className="py-2.5 pr-3">
                          <p className="text-[13px] font-medium text-fg">{delivery.email}</p>
                          {delivery.subject ? (
                            <p className="max-w-[320px] truncate text-xs text-muted">
                              {delivery.subject}
                            </p>
                          ) : null}
                          {delivery.error ? (
                            <p className="mt-0.5 text-xs text-warning-text">{delivery.error}</p>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {delivery.status === 'failed' && delivery.attempts > 1 ? (
                            <p className="mt-1 text-xs text-muted">{delivery.attempts} attempts</p>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3 text-[13px]">
                          <Link
                            to={`/scans/${delivery.scanId}`}
                            className="text-accent-text hover:underline"
                          >
                            View report
                          </Link>
                        </td>
                        <td className="py-2.5 text-[13px] text-muted">
                          <time dateTime={delivery.sentAt ?? delivery.createdAt}>
                            {relativeTime(delivery.sentAt ?? delivery.createdAt)}
                          </time>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {deliveries.hasNextPage ? (
              <div className="mt-3 flex justify-center">
                <Button
                  size="sm"
                  onClick={() => void deliveries.fetchNextPage()}
                  loading={deliveries.isFetchingNextPage}
                >
                  Show older emails
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
