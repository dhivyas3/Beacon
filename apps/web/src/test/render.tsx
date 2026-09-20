import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { AppRoutes, createQueryClient, Providers } from '@/App';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

/** Renders the whole app at `route`, with a fresh query cache and no retries. */
export function renderApp(route = '/') {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, staleTime: 0, gcTime: Infinity, refetchOnWindowFocus: false },
  });
  const utils = render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, client };
}
