import { QueryClient } from '@tanstack/react-query';
import { UnauthorizedError, ForbiddenError, ValidationError, NotFoundError } from './app-error';

/**
 * Shared QueryClient. One instance per app — registered via `<QueryClientProvider>`
 * in `app/Providers.tsx`.
 *
 * Defaults chosen for a CRUD-heavy admin app:
 * - `staleTime: 30s` so we don't refetch on every render but stale data shows up promptly
 * - `gcTime: 5min` keeps cached results around after a screen unmount
 * - `refetchOnWindowFocus: false` because the data here isn't real-time; users hit refresh manually
 * - `retry: false` on client-error responses — retrying a 400/403/404 just adds latency before
 *   the user sees the error. Network errors retry once.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (
          error instanceof UnauthorizedError ||
          error instanceof ForbiddenError ||
          error instanceof ValidationError ||
          error instanceof NotFoundError
        ) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
