import { useState, useEffect, useMemo } from 'react';
import { Upload } from 'lucide-react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface VaultImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  masterPassword: string;
  onSuccess: () => void;
}

interface ParsedEntry {
  platform: string;
  loginId: string;
  password: string;
  notes: string;
}

// Parse pasted rows: one credential per line, columns separated by a tab
// (paste from a spreadsheet) or a comma. Column order: Platform, Login ID,
// Password, Notes. A row is only kept if it has both a platform and a login
// ID — password / notes are optional. A leading header row ("Platform, Login
// ID, ...") is detected and skipped so spreadsheet copies just work.
const parseRows = (raw: string): { valid: ParsedEntry[]; skipped: number } => {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let skipped = 0;
  const valid: ParsedEntry[] = [];

  lines.forEach((line, idx) => {
    const cols = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
    const [platform = '', loginId = '', password = '', notes = ''] = cols;

    // Skip an obvious header row at the top.
    if (idx === 0 && platform.toLowerCase() === 'platform') return;

    if (!platform || !loginId) {
      skipped += 1;
      return;
    }
    valid.push({ platform, loginId, password, notes });
  });

  return { valid, skipped };
};

export const VaultImportModal = ({ isOpen, onClose, masterPassword, onSuccess }: VaultImportModalProps) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  useEffect(() => {
    if (isOpen) {
      setText('');
      setError('');
    }
  }, [isOpen]);

  const { valid, skipped } = useMemo(() => parseRows(text), [text]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (valid.length === 0) {
      setError('Nothing to import. Each row needs at least a platform and a login ID.');
      return;
    }

    setLoading(true);
    try {
      const res = await client.post('/platform-credentials/import', {
        masterPassword,
        entries: valid,
      });
      const count = res.data?.data?.imported ?? res.data?.imported ?? valid.length;
      addToast(`Imported ${count} credential${count !== 1 ? 's' : ''}.`, 'success');
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to import credentials.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import Credentials">
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-lg p-3">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            Paste one credential per line. Columns in order:
            <span className="font-semibold"> Platform, Login ID, Password, Notes</span>.
            Separate columns with a comma or a tab (paste straight from a spreadsheet). Password and Notes are optional.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Rows</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'GeM, buyer@lab.in, S3cret!, Main portal\nAmazon Business, ops@lab.in, hunter2'}
            rows={8}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand resize-none"
            autoFocus
          />
        </div>

        {text.trim() && (
          <p className="text-xs text-muted">
            <span className="font-semibold text-green-700 dark:text-green-300">{valid.length}</span> ready to import
            {skipped > 0 && (
              <>
                {' · '}
                <span className="font-semibold text-amber-700 dark:text-amber-300">{skipped}</span> skipped (missing platform or login ID)
              </>
            )}
          </p>
        )}

        {error && <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-3 py-2 rounded-lg">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted border border-line rounded-lg hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || valid.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-brand rounded-full hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {loading ? 'Importing...' : `Import ${valid.length || ''}`.trim()}
          </button>
        </div>
      </form>
    </Modal>
  );
};
