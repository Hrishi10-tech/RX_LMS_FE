import { Download } from 'lucide-react';
import { Modal } from './Modal';

interface SlipPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Object URL of the fetched PDF blob, or null while loading. */
  url: string | null;
  title: string;
  /** Optional — wire the header "Download" button to the real file download. */
  onDownload?: () => void;
}

/**
 * In-app PDF slip viewer — renders a fetched slip blob in an <iframe> inside a
 * full-width modal, so a user can read it without it landing in Downloads or
 * hopping to a raw browser tab. The blob is fetched (authenticated) by the
 * caller, which also owns revoking the object URL on close.
 */
export const SlipPreviewModal = ({ isOpen, onClose, url, title, onDownload }: SlipPreviewModalProps) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      title={title}
      headerRight={onDownload && (
        <button
          type="button"
          onClick={onDownload}
          title="Download this slip as a PDF"
          className="inline-flex items-center gap-1 text-xs font-bold text-card bg-ink hover:bg-black rounded px-2.5 py-1.5 transition-colors"
        >
          <Download size={13} /> Download
        </button>
      )}
    >
      {url ? (
        <iframe
          title={title}
          src={url}
          className="w-full h-[80vh] rounded-md border border-line bg-surface"
        />
      ) : (
        <div className="w-full h-[80vh] flex items-center justify-center text-sm text-faint italic">
          Loading slip…
        </div>
      )}
    </Modal>
  );
};
