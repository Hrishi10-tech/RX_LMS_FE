import { useState, useEffect } from 'react';
import { Eye, EyeOff, Key } from 'lucide-react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface Credential {
  id: string;
  platform: string;
  loginId: string;
  password: string;
  notes?: string;
}

interface VaultCredentialModalProps {
  isOpen: boolean;
  onClose: () => void;
  credential: Credential | null;
  masterPassword: string;
  onSuccess: () => void;
}

const generatePassword = (length = 16): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+=';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
};

export const VaultCredentialModal = ({ isOpen, onClose, credential, masterPassword, onSuccess }: VaultCredentialModalProps) => {
  const [platform, setPlatform] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const isEdit = !!credential;

  useEffect(() => {
    if (credential) {
      setPlatform(credential.platform);
      setLoginId(credential.loginId);
      setPassword(credential.password);
      setNotes(credential.notes || '');
    } else {
      setPlatform('');
      setLoginId('');
      setPassword('');
      setNotes('');
    }
    setShowPassword(false);
  }, [credential, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!platform.trim() || !loginId.trim()) {
      addToast('Platform and Login ID are required.', 'error');
      return;
    }

    setLoading(true);
    try {
      const payload = { platform, loginId, password, notes, masterPassword };
      if (isEdit) {
        await client.patch(`/platform-credentials/${credential.id}`, payload);
        addToast('Credential updated.', 'success');
      } else {
        await client.post('/platform-credentials', payload);
        addToast('Credential added.', 'success');
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      addToast(extractErrorMessage(err, 'Failed to save credential.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? 'Edit Credential' : 'Add Credential'}>
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-ink mb-1">Platform</label>
          <input
            type="text"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="e.g. GeM, Amazon Business"
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Login ID / Email</label>
          <input
            type="text"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            placeholder="username or email"
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Password</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password (optional)"
                className="w-full px-3 py-2 pr-10 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-secondary"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              title="Generate random password"
              className="px-3 py-2 border border-line rounded-lg text-muted hover:text-brand hover:border-brand transition-colors"
            >
              <Key className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional notes..."
            rows={2}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand resize-none"
          />
        </div>

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
            {loading ? 'Saving...' : isEdit ? 'Update' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
