import { useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { useToast } from '@/context/ToastContext';

/**
 * The photo on one indent line — view only.
 *
 * Procurement sources from these, which is the whole reason the requester can
 * attach one: a part number and a name leave "which one is this?" unanswered
 * more often than you would think. Attaching is the requester's job and
 * happens on the raise form; nobody downstream can add or replace one, so a
 * photo here is always the requester's own evidence.
 *
 * Fetched through the auth-gated endpoint into a blob URL rather than linked
 * directly. A plain <img src> would need the route to be public, and these are
 * photos of a company's lab.
 */
export function IndentItemAttachment({
  indentId,
  itemId,
  hasAttachment,
}: {
  indentId: string;
  itemId: string;
  hasAttachment: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();

  if (!hasAttachment) return <span className="text-[10px] text-faint">—</span>;

  const view = async () => {
    if (url) { setUrl(null); return; }   // second click closes it
    setBusy(true);
    try {
      const res = await client.get(`/indents/${indentId}/items/${itemId}/attachment`, { responseType: 'blob' });
      setUrl(URL.createObjectURL(res.data as Blob));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the photo'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={view}
        disabled={busy}
        className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-dark hover:underline disabled:opacity-50"
        title={url ? 'Hide the photo' : 'Show the photo the requester attached'}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
        {url ? 'Hide' : 'Photo'}
      </button>
      {url && (
        // Small inline preview, click through for full size in a new tab —
        // the table cell is far too narrow to judge a component from.
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src={url} alt="Attached by the requester" className="max-h-24 rounded border border-line" />
        </a>
      )}
    </div>
  );
}
