import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, Lock, Unlock, KeyRound } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { VaultSetupForm } from '../components/VaultSetupForm';
import { VaultUnlockForm } from '../components/VaultUnlockForm';
import { VaultCredentialTable } from '../components/VaultCredentialTable';
import { VaultChangePasswordModal } from '../components/VaultChangePasswordModal';
import { useAbortOnUnmount } from '@/hooks';

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

interface Credential {
  id: string;
  platform: string;
  loginId: string;
  password: string;
  notes?: string;
}

export const VaultPage = () => {


  const abortSignal = useAbortOnUnmount();

  const [vaultState, setVaultState] = useState<'loading' | 'setup' | 'locked' | 'unlocked'>('loading');
  const [masterPassword, setMasterPassword] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const { addToast } = useToast();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check vault status on mount
  useEffect(() => {
    checkVaultStatus();
  }, []);

  const checkVaultStatus = async () => {
    try {
      const { data } = await client.get('/platform-credentials/status', { signal: abortSignal() });
      if (data?.data?.isSetup || data?.isSetup) {
        setVaultState('locked');
      } else {
        setVaultState('setup');
      }
    } catch {
      // If endpoint doesn't exist yet or errors, assume not set up
      setVaultState('setup');
    }
  };

  // Auto-lock timer
  const resetAutoLock = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (vaultState === 'unlocked') {
      timerRef.current = setTimeout(() => {
        lockVault();
        addToast('Vault auto-locked after 5 minutes of inactivity.', 'info');
      }, AUTO_LOCK_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the auto-lock timer only needs to re-arm on vaultState change; addToast (toast context) fires inside the timeout and must not rebuild this callback
  }, [vaultState]);

  useEffect(() => {
    if (vaultState !== 'unlocked') return;

    resetAutoLock();

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    const handler = () => resetAutoLock();
    events.forEach((evt) => document.addEventListener(evt, handler));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((evt) => document.removeEventListener(evt, handler));
    };
  }, [vaultState, resetAutoLock]);

  const fetchCredentials = useCallback(async (mp: string) => {
    try {
      const { data } = await client.post('/platform-credentials/unlock', { masterPassword: mp });
      setCredentials(data?.data?.credentials || data?.credentials || []);
    } catch (err: any) {
      const msg = extractErrorMessage(err, 'Failed to fetch credentials.');
      addToast(msg, 'error');
      // If master password is wrong, go back to locked
      if (err.response?.status === 401 || err.response?.status === 403) {
        setMasterPassword('');
        setVaultState('locked');
      }
    }
  }, [addToast]);

  const handleUnlock = useCallback(async (mp: string) => {
    try {
      // Verify the master password by fetching credentials
      const { data } = await client.post('/platform-credentials/unlock', { masterPassword: mp });
      setMasterPassword(mp);
      setCredentials(data?.data?.credentials || data?.credentials || []);
      setVaultState('unlocked');
      addToast('Vault unlocked.', 'success');
    } catch (err: any) {
      addToast(extractErrorMessage(err, 'Invalid master password.'), 'error');
    }
  }, [addToast]);

  const lockVault = () => {
    setMasterPassword('');
    setCredentials([]);
    setVaultState('locked');
  };

  const handleSetupComplete = () => {
    setVaultState('locked');
  };

  const handleRefresh = () => {
    if (masterPassword) {
      fetchCredentials(masterPassword);
    }
  };

  // Loading state
  if (vaultState === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted">Checking vault status...</p>
        </div>
      </div>
    );
  }

  // Setup state
  if (vaultState === 'setup') {
    return <VaultSetupForm onSetupComplete={handleSetupComplete} />;
  }

  // Locked state
  if (vaultState === 'locked') {
    return <VaultUnlockForm onUnlock={handleUnlock} />;
  }

  // Unlocked state
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-brand/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-brand" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-ink">Password Vault</h1>
            <p className="text-sm text-muted">
              {credentials.length} credential{credentials.length !== 1 ? 's' : ''} stored
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChangePassword(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted border border-line rounded-lg hover:bg-surface hover:text-brand hover:border-brand/40 transition-colors"
          >
            <KeyRound className="w-4 h-4" />
            Change Password
          </button>
          <button
            onClick={lockVault}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted border border-line rounded-lg hover:bg-surface hover:text-red-700 dark:text-red-300 hover:border-red-200 dark:border-red-400/30 transition-colors"
          >
            <Lock className="w-4 h-4" />
            Lock Vault
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-green-50 dark:bg-green-400/15 border border-green-200 dark:border-green-400/30 rounded-lg">
        <Unlock className="w-4 h-4 text-green-700 dark:text-green-300" />
        <span className="text-xs text-green-700 dark:text-green-300 font-medium">Vault unlocked — auto-locks after 5 minutes of inactivity</span>
      </div>

      {/* Credentials table */}
      <VaultCredentialTable
        credentials={credentials}
        masterPassword={masterPassword}
        onRefresh={handleRefresh}
      />

      {/* Change master password — keeps the open session valid by swapping
          the in-memory master password to the new one on success. */}
      <VaultChangePasswordModal
        isOpen={showChangePassword}
        onClose={() => setShowChangePassword(false)}
        onSuccess={(newPassword) => setMasterPassword(newPassword)}
      />
    </div>
  );
};
