import { useState } from 'react';
import { Shield } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface VaultSetupFormProps {
  onSetupComplete: () => void;
}

export const VaultSetupForm = ({ onSetupComplete }: VaultSetupFormProps) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Master password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await client.post('/platform-credentials/setup', { masterPassword: password });
      addToast('Vault created successfully!', 'success');
      onSetupComplete();
    } catch (err: any) {
      const msg = extractErrorMessage(err, 'Failed to set up vault.');
      setError(msg);
      addToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="bg-card rounded-xl shadow-sm border border-line-soft p-8 w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-full bg-brand/10 flex items-center justify-center mb-4">
            <Shield className="w-7 h-7 text-brand" />
          </div>
          <h2 className="text-xl font-bold text-ink">Set Up Password Vault</h2>
          <p className="text-sm text-muted mt-2 text-center">
            Create a master password to encrypt and protect your platform credentials. This cannot be recovered if lost.
          </p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Master Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter master password"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              required
            />
          </div>

          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-3 py-2 rounded-lg">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-brand text-white text-sm font-semibold rounded-full hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            {loading ? 'Creating Vault...' : 'Create Vault'}
          </button>
        </form>
      </div>
    </div>
  );
};
