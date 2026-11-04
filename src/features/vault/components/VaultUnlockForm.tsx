import { useState } from 'react';
import { Lock, Mail, ArrowLeft } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface VaultUnlockFormProps {
  onUnlock: (masterPassword: string) => void;
  onResetComplete?: () => void;
}

export const VaultUnlockForm = ({ onUnlock, onResetComplete }: VaultUnlockFormProps) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  // Reset flow state
  const [resetMode, setResetMode] = useState<'off' | 'email' | 'otp'>('off');
  const [resetEmail, setResetEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password.trim()) { setError('Please enter your master password.'); return; }
    setLoading(true);
    try {
      await onUnlock(password);
    } catch {
      setError('Invalid master password.');
    } finally {
      setLoading(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) { setError('Enter your procurement email.'); return; }
    setResetLoading(true);
    setError('');
    try {
      await client.post('/platform-credentials/request-otp', { email: resetEmail.trim() });
      addToast('OTP sent to your email.', 'success');
      setResetMode('otp');
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to send OTP.'));
    } finally {
      setResetLoading(false);
    }
  };

  const handleVerifyAndReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim()) { setError('Enter the OTP.'); return; }
    if (newPassword.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setResetLoading(true);
    setError('');
    try {
      await client.post('/platform-credentials/reset-with-otp', {
        email: resetEmail.trim(),
        otp,
        newPassword,
      });
      addToast('Master password reset successfully. You can now log in.', 'success');
      setResetMode('off');
      setResetEmail('');
      setOtp('');
      setNewPassword('');
      setConfirmPassword('');
      onResetComplete?.();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to reset. Check your OTP.'));
    } finally {
      setResetLoading(false);
    }
  };

  const backToUnlock = () => {
    setResetMode('off');
    setError('');
    setResetEmail('');
    setOtp('');
    setNewPassword('');
    setConfirmPassword('');
  };

  // --- Reset: Enter Email ---
  if (resetMode === 'email') {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="bg-card rounded-xl shadow-sm border border-line-soft p-8 w-full max-w-md">
          <button onClick={backToUnlock} className="flex items-center gap-1 text-xs text-muted hover:text-ink mb-4 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to unlock
          </button>
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-full bg-amber-50 dark:bg-amber-400/15 flex items-center justify-center mb-4">
              <Mail className="w-7 h-7 text-amber-700 dark:text-amber-300" />
            </div>
            <h2 className="text-xl font-bold text-ink">Reset Master Password</h2>
            <p className="text-sm text-muted mt-2 text-center">Enter the procurement email to receive a verification code.</p>
          </div>
          <form noValidate onSubmit={handleSendOtp} className="space-y-4">
            <input
              type="email"
              value={resetEmail}
              onChange={e => setResetEmail(e.target.value)}
              placeholder="procurement@yourcompany.com"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              autoFocus required
            />
            {error && <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-3 py-2 rounded-lg">{error}</p>}
            <div className="bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-lg p-3">
              <p className="text-xs text-blue-700 dark:text-blue-300"><span className="font-bold">Info:</span> Your credentials are safe. Resetting verifies your identity via OTP and restores access without data loss.</p>
            </div>
            <button type="submit" disabled={resetLoading}
              className="w-full py-2.5 bg-brand text-white text-sm font-semibold rounded-full hover:bg-brand-600 transition-colors disabled:opacity-50">
              {resetLoading ? 'Sending OTP...' : 'Send OTP'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Reset: Enter OTP + New Password ---
  if (resetMode === 'otp') {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="bg-card rounded-xl shadow-sm border border-line-soft p-8 w-full max-w-md">
          <button onClick={() => setResetMode('email')} className="flex items-center gap-1 text-xs text-muted hover:text-ink mb-4 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-400/15 flex items-center justify-center mb-4">
              <Lock className="w-7 h-7 text-green-700 dark:text-green-300" />
            </div>
            <h2 className="text-xl font-bold text-ink">Verify & Set New Password</h2>
            <p className="text-sm text-muted mt-2 text-center">Enter the 6-digit code sent to <span className="font-bold">{resetEmail}</span></p>
          </div>
          <form noValidate onSubmit={handleVerifyAndReset} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1">OTP Code</label>
              <input
                type="text"
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
                maxLength={6} autoFocus required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1">New Master Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
                minLength={8} required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
                minLength={8} required
              />
            </div>
            {error && <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-3 py-2 rounded-lg">{error}</p>}
            <button type="submit" disabled={resetLoading}
              className="w-full py-2.5 bg-green-700 text-white text-sm font-semibold rounded-lg hover:bg-green-800 transition-colors disabled:opacity-50">
              {resetLoading ? 'Resetting...' : 'Secure & Reset Master Password'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Default: Unlock form ---
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="bg-card rounded-xl shadow-sm border border-line-soft p-8 w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-full bg-brand/10 flex items-center justify-center mb-4">
            <Lock className="w-7 h-7 text-brand" />
          </div>
          <h2 className="text-xl font-bold text-ink">Vault Locked</h2>
          <p className="text-sm text-muted mt-2 text-center">
            Enter your master password to access the credential vault.
          </p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Master Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter master password"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
              autoFocus required
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
            {loading ? 'Unlocking...' : 'Unlock Vault'}
          </button>

          <div className="text-center pt-1">
            <button
              type="button"
              onClick={() => setResetMode('email')}
              className="text-xs text-faint hover:text-brand transition-colors"
            >
              Forgot master password?
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
