// Sticky banner that surfaces when the app can't reach the backend.
// Driven by `api-offline` / `api-online` events the axios interceptor
// fires whenever a request fails without a response (server down, network
// dropped, CORS blocked) and clears when a subsequent request succeeds.
//
// Why this is a separate component instead of a toast: a toast disappears
// after a few seconds. Offline state can last minutes; the user needs a
// persistent indicator so they don't keep clicking buttons that silently
// fail. Toasts handle the per-action error reporting; this banner handles
// the "everything is broken right now" condition.

import { useEffect, useState } from 'react';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline  = () => setOffline(false);
    window.addEventListener('api-offline', goOffline);
    window.addEventListener('api-online', goOnline);
    // Also react to the browser's native offline state — covers the
    // "user pulled their laptop off wifi" case BEFORE they even click
    // anything in the app.
    const handleNative = () => setOffline(!navigator.onLine);
    window.addEventListener('offline', handleNative);
    window.addEventListener('online', handleNative);
    handleNative();
    return () => {
      window.removeEventListener('api-offline', goOffline);
      window.removeEventListener('api-online', goOnline);
      window.removeEventListener('offline', handleNative);
      window.removeEventListener('online', handleNative);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[9999] bg-red-600 text-white text-center text-xs font-bold py-2 px-4 shadow-md flex items-center justify-center gap-2">
      <span className="inline-block w-2 h-2 rounded-full bg-card/90 animate-pulse" />
      Can't reach the server — your changes won't save until the connection is back.
    </div>
  );
}
