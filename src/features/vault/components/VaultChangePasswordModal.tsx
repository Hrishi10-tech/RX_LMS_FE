import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface VaultChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Returns the new master password so the open session keeps working
  // (subsequent create/edit/delete calls verify against the new gate).
  onSuccess: (newPassword: string) => void;
}

export const VaultChangePasswordModal = ({ isOpen, onClose, onSuccess }: VaultChangePasswordModalProps) => {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  // Reset the form every time the modal opens so a previous attempt's
  // values never linger.
  useEffect(() => {
    if (isOpen) {
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setShowOld(false);
      setShowNew(false);
      setError('');
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!oldPassword) { setError('Enter your current master password.'); return; }
    if (newPassword.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (newPassword !== confirm) { setError('New passwords do not match.'); return; }
    if (newPassword === oldPassword) { setError('New password must be different from the current one.'); return; }

    setLoading(true);
    try {
      await client.post('/platform-credentials/change-password', { oldPassword, newPassword });
      addToast('Master password changed.', 'success');
      onSuccess(newPassword);
      onClose();
    } catch (err: any) {
      if (err?.response?.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else {
        setError(extractErrorMessage(err, 'Failed to change master password.'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Change Master Password">
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-lg p-3">
          <p className="text-xs text-amber-700 dark:text-amber-300">
            <span className="font-bold">Note:</span> Your stored credentials stay intact — only the password that unlocks the vault changes.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Current Password</label>
          <div className="relative">
            <input
              type={showOld ? 'text' : 'password'}
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="Enter current master password"
              className="w-full px-3 py-2 pr-10 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowOld(!showOld)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-secondary"
            >
              {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">New Password</label>
          <div className="relative">
            <input
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 8 characters"
              className="w-full px-3 py-2 pr-10 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
            />
            <button
              type="button"
              onClick={() => setShowNew(!showNew)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-secondary"
            >
              {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Confirm New Password</label>
          <input
            type={showNew ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter new password"
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
          />
        </div>

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
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-brand rounded-full hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            {loading ? 'Changing...' : 'Change Password'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
