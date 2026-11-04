import { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { AuthProvider, ToastProvider, SocketProvider, ConfirmProvider } from '@/context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { queryClient } from '@/lib/queryClient';
import { TooltipLayer } from '@/components/ui/TooltipLayer';

/**
 * Consolidated provider tree. Ordering matters:
 *  - Router first (so any provider can use route hooks)
 *  - QueryClientProvider before AuthProvider so auth queries can use RQ
 *  - ToastProvider before AuthProvider so login errors can toast
 *  - SocketProvider after AuthProvider because socket connection needs the auth token
 *  - ErrorBoundary innermost so it catches render errors from any provider's children
 */
export function Providers({ children }: { children: ReactNode }) {
  // No `future` prop on v7: both flags this used to set —
  // v7_startTransition (state updates wrapped in React.startTransition) and
  // v7_relativeSplatPath (relative paths inside splat routes) — are the
  // default behaviour now, and passing them is a type error. Opting in early
  // on v6 is what made this major a one-line change.
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
        <ToastProvider>
          <AuthProvider>
            <SocketProvider>
              {/* ConfirmProvider gives every page a global `useConfirm()` hook
                  that replaces native window.confirm with the themed dialog. */}
              <ConfirmProvider>
                <ErrorBoundary>{children}</ErrorBoundary>
                {/* Anchors every `title` tooltip to its control. Native ones
                    are placed at the cursor and clamped to the viewport, so a
                    long one on a right-aligned button slides hundreds of
                    pixels away and points at nothing. Mounted once; no call
                    site changes. */}
                <TooltipLayer />
              </ConfirmProvider>
            </SocketProvider>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
