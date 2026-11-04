import { useEffect, useRef, useState } from 'react';
import { Paperclip, Image as ImageIcon, Loader2, Download, Maximize2 } from 'lucide-react';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { useToast } from '@/context/ToastContext';
import { Modal } from '@/components/ui';
import { useAbortOnUnmount } from '@/hooks';
import { PHOTO_VIDEO_ACCEPT } from '@/lib/fileAccept';

/**
 * The photo on a component request: view it full size, download it, and (if you
 * raised it) attach or replace it.
 *
 * The file is never linked directly. It's fetched through the auth-gated
 * `GET /requests/:id/attachment` into a blob URL, because a plain <img src>
 * would need the endpoint to be public — and these are photos of a company's
 * lab, not something to leave open.
 *
 * The inline render is a THUMBNAIL (max-h-56). A phone photo or a screenshot is
 * several times that tall, so what the slip shows is a heavily downscaled copy —
 * it is not what was uploaded. Whoever is deciding on the request (inventory
 * accepting a return, procurement reading a part number off a label) has to be
 * able to get at the original, so the thumbnail opens a full-size viewer and
 * there is a download beside it. The stored file is untouched: nothing in the
 * upload path resizes or re-encodes.
 */

/** Filename out of `Content-Disposition`, else one derived from the MIME type. */
const filenameFor = (disposition: string | undefined, mime: string, requestId: string): string => {
  const m = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m?.[1]) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  return `request-${requestId.slice(0, 8)}.${ext}`;
};

export function RequestAttachment({
  requestId,
  hasAttachment,
  canAttach,
  onChanged,
}: {
  requestId: string;
  hasAttachment: boolean;
  canAttach: boolean;
  onChanged?: () => void;
}) {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [url, setUrl] = useState<string | null>(null);
  const [mime, setMime] = useState<string>('');
  const [filename, setFilename] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [present, setPresent] = useState(hasAttachment);
  const [zoomed, setZoomed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  // Blob URLs pin the whole file in memory until they're revoked. The old code
  // left that to navigation, which never happens inside a single-page app — a
  // few 150 MB videos opened one after another would just accumulate.
  const urlRef = useRef<string | null>(null);
  useEffect(() => { urlRef.current = url; }, [url]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const view = async () => {
    setBusy(true);
    try {
      const res = await client.get(`/requests/${requestId}/attachment`, { responseType: 'blob', signal: abortSignal() });
      const blob = res.data as Blob;
      const type = blob.type || '';
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      setMime(type);
      setFilename(filenameFor(res.headers?.['content-disposition'], type, requestId));
      setUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the photo'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const body = new FormData();
      body.append('attachment', file);
      await client.post(`/requests/${requestId}/attachment`, body, {
        // The shared axios instance sets 'Content-Type: application/json' as a
        // DEFAULT header. A FormData body therefore went out declared as JSON
        // and multer parsed no file — this upload had never worked, which is
        // why not one component request carried a photo.
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      addToast('Photo attached', 'success');
      setPresent(true);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      setUrl(null);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not attach the photo'), 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // An attachment may be a short video, not only a photo — the upload accepts
  // both. Rendering one through <img> showed a broken-image icon.
  const isVideo = mime.startsWith('video/');

  return (
    <div className="mt-3">
      <div className="flex items-center gap-3">
        <p className="text-[10px] text-faint uppercase font-bold">Photo</p>
        {busy && <Loader2 className="w-3.5 h-3.5 text-faint animate-spin" />}
      </div>

      {present ? (
        url ? (
          <div className="mt-1.5">
            {isVideo ? (
              <video src={url} controls className="max-h-56 rounded-md border border-line" />
            ) : (
              <button
                type="button"
                onClick={() => setZoomed(true)}
                title="Open the full-size photo"
                className="group relative block rounded-md border border-line overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand-dark"
              >
                <img src={url} alt="Attached to this request" className="max-h-56 object-contain" />
                <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/35">
                  <Maximize2 className="w-5 h-5 text-white" />
                </span>
              </button>
            )}
            <div className="mt-1.5 flex items-center gap-3">
              {!isVideo && (
                <button onClick={() => setZoomed(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-dark hover:underline">
                  <Maximize2 className="w-3.5 h-3.5" />Full size
                </button>
              )}
              <a href={url} download={filename}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-muted hover:text-ink">
                <Download className="w-3.5 h-3.5" />Download
              </a>
            </div>
          </div>
        ) : (
          <button onClick={view} disabled={busy}
            className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-bold text-brand-dark hover:underline disabled:opacity-50">
            <ImageIcon className="w-3.5 h-3.5" />Show the photo
          </button>
        )
      ) : (
        <p className="mt-1 text-xs text-faint italic">None attached.</p>
      )}

      {canAttach && (
        <>
          <input ref={fileRef} type="file" accept={PHOTO_VIDEO_ACCEPT} className="hidden"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-muted hover:text-ink disabled:opacity-50">
            <Paperclip className="w-3.5 h-3.5" />{present ? 'Replace photo' : 'Attach a photo'}
          </button>
          <p className="text-[10px] text-faint mt-1">Image or short video, up to 25 MB.</p>
        </>
      )}

      {/* Modal tracks its own stacking depth, so this paints above the request
          slip that opened it rather than behind it. */}
      {zoomed && url && (
        <Modal
          isOpen
          onClose={() => setZoomed(false)}
          title="Attached photo"
          size="full"
          headerRight={
            <a href={url} download={filename}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-dark hover:underline">
              <Download className="w-3.5 h-3.5" />Download
            </a>
          }
        >
          <img src={url} alt="Attached to this request"
               className="mx-auto max-h-[80vh] w-auto object-contain" />
        </Modal>
      )}
    </div>
  );
}
