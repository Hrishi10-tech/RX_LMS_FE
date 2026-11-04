import React from 'react';
import { Modal } from '@/components/ui';
import { SHEET_ACCEPT } from '@/lib/fileAccept';

export interface BulkUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isUploading: boolean;
}

export const BulkUploadModal: React.FC<BulkUploadModalProps> = ({
  isOpen,
  onClose,
  onFileUpload,
  isUploading,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Upload Components CSV">
      <div className="space-y-4 md:space-y-6">
        <p className="text-sm text-muted">
          Upload a <strong>.csv</strong> or <strong>.xlsx</strong> file. Column headers are auto-detected — common formats like Name, Description, Quantity, Stock, Location, Category etc. all work.
        </p>
        <div className="border-2 border-dashed border-line rounded-lg p-10 text-center hover:bg-surface transition-colors">
          <input type="file" accept={SHEET_ACCEPT} onChange={onFileUpload} disabled={isUploading}
            className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-brand/10 file:text-brand hover:file:bg-brand/20 cursor-pointer" />
          {isUploading && <p className="mt-4 text-brand font-bold">Processing...</p>}
        </div>
        <div className="flex justify-end border-t border-line-soft pt-3">
          <button onClick={onClose} className="text-muted px-6 py-2 font-bold rounded-md hover:bg-hover transition-colors">Close</button>
        </div>
      </div>
    </Modal>
  );
};
