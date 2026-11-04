import { useRef, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { Upload, Loader2, X } from 'lucide-react';

/**
 * The Upload cell on a vendor's row.
 *
 * Opens a small dialog rather than firing the file picker straight from the
 * cell, because the optional name is typed alongside the files — a picker that
 * uploads the instant you choose leaves nowhere to put it.
 *
 * One name for the whole batch on purpose: asking for a name per file when
 * somebody selects six price lists is worse than asking for none.
 */

const ACCEPT = '.pdf,.xlsx,.xls';
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;

export function VendorUploadButton({
  vendor,
  onUploaded,
}: {
  vendor: { id: string; vendorName: string };
  onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  const reset = () => { setFiles([]); setName(''); if (inputRef.current) inputRef.current.value = ''; };

  const pick = (list: FileList | null) => {
    const chosen = Array.from(list || []);
    if (!chosen.length) return;
    // Caught here as well as on the server: the server is the authority, but a
    // 25 MB file rejected after it uploads wastes the user's time and the
    // connection, and the message arrives far too late to be useful.
    const tooBig = chosen.find(f => f.size > MAX_BYTES);
    if (tooBig) { addToast(`"${tooBig.name}" is larger than 25 MB.`, 'error'); return; }
    if (chosen.length > MAX_FILES) { addToast(`At most ${MAX_FILES} files at a time.`, 'error'); return; }
    setFiles(chosen);
  };

  const submit = async () => {
    if (!files.length) { addToast('Choose at least one file', 'error'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      // Field name must be `files` — it is what FilesInterceptor('files', …)
      // reads on the server.
      files.forEach(f => fd.append('files', f));
      fd.append('vendorCodeId', vendor.id);
      if (name.trim()) fd.append('notes', name.trim());
      // The shared axios instance sets a JSON content-type by default, which
      // strips the multipart boundary and reaches the server as "no file
      // received". Every upload in this app has to override it explicitly.
      await client.post('/vendor-forms', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      addToast(`${files.length} file${files.length === 1 ? '' : 's'} uploaded to ${vendor.vendorName}`, 'success');
      setOpen(false);
      reset();
      onUploaded();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Upload failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-bold text-brand bg-brand/10 border border-brand/20 rounded hover:bg-brand/20 transition-colors"
        title={`Upload PDFs or Excel files for ${vendor.vendorName}`}
      >
        <Upload size={12} /> Upload
      </button>

      <Modal
        isOpen={open}
        onClose={() => { if (!busy) { setOpen(false); reset(); } }}
        title={`Upload documents — ${vendor.vendorName}`}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-1">
              Files <span className="font-normal">(PDF or Excel — up to {MAX_FILES})</span>
            </label>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => pick(e.target.files)}
              className="block w-full text-xs text-ink file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-bold file:bg-brand/15 file:text-brand-dark hover:file:bg-brand/25"
            />
          </div>

          {files.length > 0 && (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs text-ink bg-surface rounded px-2 py-1">
                  <span className="truncate">{f.name}</span>
                  <button
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="p-0.5 text-faint hover:text-red-700 shrink-0"
                    title="Remove from this upload"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div>
            <label className="block text-xs font-bold text-muted mb-1">
              Name <span className="font-normal">(optional — shown in the documents list)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Price list 2026"
              className="w-full px-3 py-2 text-sm border border-line rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => { setOpen(false); reset(); }}
              disabled={busy}
              className="px-3 py-2 text-sm font-bold text-muted hover:bg-hover rounded-md disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || files.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-brand rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? 'Uploading…' : `Upload${files.length ? ` ${files.length}` : ''}`}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
