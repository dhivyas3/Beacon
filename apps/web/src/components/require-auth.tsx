import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiClientError } from '@/api/client';
import { useSession } from '@/api/hooks';
import { ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';

/** Sends people who are not signed in to the login page, and back afterwards. */
export function RequireAuth() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return (
      <div className="mx-auto max-w-[1240px] space-y-4 px-6 py-8" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (session.isError) {
    if (session.error instanceof ApiClientError && session.error.status === 401) {
      const next = `${location.pathname}${location.search}`;
      return (
        <Navigate to={`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} replace />
      );
    }
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <ErrorState
          title="Could not load your account"
          error={session.error}
          onRetry={() => void session.refetch()}
        />
      </div>
    );
  }

  return <Outlet />;
}
