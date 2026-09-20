import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ApiClientError, onUnauthorized } from '@/api/client';
import { keys } from '@/api/hooks';
import { AppShell } from '@/components/app-shell';
import { RequireAuth } from '@/components/require-auth';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme';
import { DashboardPage } from '@/pages/dashboard';
import { LoginPage } from '@/pages/login';
import { NotFoundPage } from '@/pages/not-found';

// The report pulls in the charting library and settings is rarely opened, so neither is part of
// the first download. The dashboard and sign-in stay in the main bundle.
const ScanPage = lazy(() => import('@/pages/scan').then((m) => ({ default: m.ScanPage })));
const SettingsPage = lazy(() =>
  import('@/pages/settings').then((m) => ({ default: m.SettingsPage })),
);

function PageFallback() {
  return <div role="status" aria-label="Loading page" className="h-64" />;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: (count, error) =>
          !(error instanceof ApiClientError && error.status >= 400 && error.status < 500) &&
          count < 2,
      },
    },
  });
}

/** Routes only, so tests can mount them inside their own router. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route
            path="scans/:id"
            element={
              <Suspense fallback={<PageFallback />}>
                <ScanPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={<PageFallback />}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

/** Providers shared by the real app and by tests. */
export function Providers({
  client,
  children,
}: {
  client: QueryClient;
  children: React.ReactNode;
}) {
  useEffect(() => {
    // A 401 anywhere means the session may have ended. Ask again: if it really has, the guard
    // gets a 401 for /auth/me and sends people to sign in.
    onUnauthorized(() => {
      void client.invalidateQueries({ queryKey: keys.session });
    });
    return () => onUnauthorized(null);
  }, [client]);

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <Providers client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Providers>
  );
}
