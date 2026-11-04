// Handles the "this tab is running last week's code" problem.
//
// When a newer build is detected (see lib/versionWatch), the page reloads
// itself — but only while nothing is being typed. If a modal is open or any
// field has content, it shows this bar and waits, because reloading over
// someone's half-filled slip is the same mistake as letting Escape discard
// it, just with a bigger blast radius.
//
// Separate from OfflineBanner despite looking similar: that one reports a
// condition the user can't act on, this one asks for a decision.

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { startVersionWatch, safeToReload } from '@/lib';

export function NewVersionBanner() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    return startVersionWatch(() => {
      if (safeToReload()) {
        // Nothing in progress — just take the new version.
        window.location.reload();
        return;
      }
      setPending(true);
    });
  }, []);

  // Once it's waiting, watch for the work to finish (modal closed, form
  // submitted) and take that moment. Cheap: one DOM check every few seconds,
  // and it stops as soon as it fires.
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => {
      if (safeToReload()) window.location.reload();
    }, 5000);
    return () => window.clearInterval(t);
  }, [pending]);

  if (!pending) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] max-w-sm bg-ink text-card rounded-lg shadow-lg px-4 py-3 flex items-start gap-3">
      <RefreshCw className="w-4 h-4 mt-0.5 text-brand shrink-0" />
      <div className="min-w-0">
        <p className="text-xs font-bold">A newer version is ready</p>
        <p className="text-[11px] text-white/70 mt-0.5">
          Finish what you're typing — this page refreshes itself once you're done, or reload now.
        </p>
      </div>
      <button
        onClick={() => window.location.reload()}
        className="text-[11px] font-bold bg-brand text-white px-2.5 py-1 rounded-full hover:bg-brand-dark transition-colors shrink-0"
      >
        Reload
      </button>
    </div>
  );
}

