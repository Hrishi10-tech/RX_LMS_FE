import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { MessageSquare, Image as ImageIcon, X } from 'lucide-react';
import { feedbackApi } from '../services/feedback.api';
import { PHOTO_VIDEO_ACCEPT } from '@/lib/fileAccept';

/**
 * Floating "Feedback" trigger + modal. Rendered globally in DashboardLayout
 * so every authenticated role gets the same surface. Submission posts to
 * `/feedback` with an optional image/video attachment (multipart). The
 * SUPER_ADMIN reads them all from `/super-admin/feedback`.
 */
export const FeedbackButton = () => {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setMessage(''); setFile(null); };

  const close = () => { if (submitting) return; setOpen(false); reset(); };

  const submit = async () => {
    if (!message.trim()) { addToast('Type your feedback first.', 'error'); return; }
    setSubmitting(true);
    try {
      await feedbackApi.submit(message.trim(), file ?? undefined);
      addToast('Thanks — feedback sent.', 'success');
      reset();
      setOpen(false);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to send feedback'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    if (f && f.size > 25 * 1024 * 1024) {
      addToast('Attachment too large — must be ≤ 25 MB.', 'error');
      return;
    }
    setFile(f);
  };

  // Lightweight preview for the chosen file. Memoize the object URL on the
  // file so we mint exactly one per pick (the old render-body call created a
  // fresh blob URL on EVERY render and never revoked any of them — a leak for
  // the page's lifetime). createObjectURL handles are NOT garbage-collected,
  // so we explicitly revoke in the effect cleanup below.
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const isVideo = file?.type.startsWith('video/');

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  return (
    <>
      {/* Pill button (icon + label) so every role notices it. Branded
          amber background — same accent the app uses elsewhere — and it
          sits in the TopBar between role-name and the bell. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Send feedback to the team — bug, idea, or anything else"
        aria-label="Send feedback"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-brand text-white hover:bg-brand-dark transition-colors shadow-sm"
      >
        <MessageSquare className="w-[14px] h-[14px]" />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <Modal isOpen={open} onClose={close} title="Send feedback">
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
              What's on your mind?
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Found a bug? Have an idea? Stuck on something? Tell us here. The team reviews every submission."
              rows={5}
              maxLength={4000}
              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none resize-y"
            />
            <p className="text-[10px] text-faint mt-1 text-right">{message.length} / 4000</p>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
              Attachment (optional)
            </label>
            <input
              ref={fileRef}
              type="file"
              accept={PHOTO_VIDEO_ACCEPT}
              onChange={pickFile}
              className="hidden"
            />
            {!file && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-2 px-3 py-2 border border-dashed border-line rounded-md text-xs font-bold text-muted hover:bg-surface">
                <ImageIcon size={14} /> Choose image or video
              </button>
            )}
            {file && previewUrl && (
              <div className="relative border border-line rounded-md overflow-hidden bg-surface">
                {isVideo ? (
                  <video src={previewUrl} controls className="w-full max-h-64 bg-black" />
                ) : (
                  <img src={previewUrl} alt="preview" className="w-full max-h-64 object-contain" />
                )}
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  title="Remove attachment"
                  className="absolute top-1 right-1 bg-black/60 text-white p-1 rounded-full hover:bg-black/80">
                  <X size={12} />
                </button>
                <div className="px-3 py-1.5 text-[10px] text-muted border-t border-line-soft bg-card truncate">
                  <span className="font-bold">{file.name}</span>
                  <span className="ml-2 text-faint">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
              </div>
            )}
            <p className="text-[10px] text-faint mt-1">
              Images or videos up to 25 MB. Helps the team see exactly what you saw.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
            <button type="button" onClick={close} disabled={submitting}
              className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={submitting || !message.trim()}
              className="bg-brand text-white px-5 py-2 rounded-full font-bold text-sm hover:bg-brand-dark disabled:opacity-50 shadow-sm">
              {submitting ? 'Sending…' : 'Send feedback'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};
