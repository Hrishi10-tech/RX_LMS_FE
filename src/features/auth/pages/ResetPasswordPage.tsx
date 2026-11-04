import { useState, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { authApi } from '../services/auth.api';
import { passwordProblem } from '@/lib/passwordRule';

/** Show/hide toggle rendered inside a password field's right edge. */
const PasswordToggle = ({ shown, onToggle }: { shown: boolean; onToggle: () => void }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-label={shown ? 'Hide password' : 'Show password'}
    tabIndex={-1}
    className="absolute inset-y-0 right-0 flex items-center pr-3 text-faint hover:text-ink"
  >
    {shown ? <EyeOff size={18} /> : <Eye size={18} />}
  </button>
);

/**
 * Unauthenticated "forgot password" step 2: the emailed link lands here with
 * ?token=…. Enter + confirm a new password to consume the token. Password rule
 * mirrors the backend (≥8 chars, ≥1 letter + ≥1 digit).
 */
export const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const pwErr = passwordProblem(password);
    if (pwErr) { setError(pwErr); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setIsLoading(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'This reset link is invalid or has expired. Request a new one.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-zebra to-white font-sans">
      <div className="hidden lg:flex w-1/2 bg-brand p-12 flex-col justify-between items-start text-white relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full bg-black/5 z-0"></div>
        <div className="z-10 relative">
          <h1 className="text-5xl tracking-tight mb-4 font-bold text-white">LMS</h1>
          <p className="text-xl text-white/90 font-medium">Lab Management System</p>
        </div>
        <div className="z-10 relative">
          <p className="text-sm text-white/80">Streamline your biomedical equipment &amp; inventory workflow.</p>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-4 sm:p-8 md:p-12 lg:p-16 relative w-full">
        <div className="w-full max-w-md mx-4 md:mx-auto bg-card p-6 md:p-10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-faint/20">
          <h2 className="text-xl md:text-2xl tracking-tight text-center font-bold text-ink">Set a new password</h2>

          {!token ? (
            <div className="mt-8 space-y-4 text-center">
              <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-4 text-sm text-red-700 dark:text-red-300">
                This reset link is missing its token. Request a new link.
              </div>
              <button onClick={() => navigate('/forgot-password')} className="w-full py-3 px-4 text-sm font-bold rounded-full text-white bg-brand hover:bg-brand-dark transition-colors shadow-sm">
                Request a new link
              </button>
            </div>
          ) : done ? (
            <div className="mt-8 space-y-4 text-center">
              <div className="bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-md p-4 text-sm text-emerald-800 dark:text-emerald-200">
                Your password has been reset. Sign in with your new password.
              </div>
              <button onClick={() => navigate('/login')} className="w-full py-3 px-4 text-sm font-bold rounded-full text-white bg-brand hover:bg-brand-dark transition-colors shadow-sm">
                Go to sign in
              </button>
            </div>
          ) : (
            <form noValidate className="mt-8 space-y-4 md:space-y-6" onSubmit={handleSubmit}>
              {error && (
                <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-3 text-sm text-red-700 dark:text-red-300">{error}</div>
              )}
              <div>
                <label htmlFor="new-password" className="block text-sm font-bold text-ink mb-1">New password</label>
                <div className="relative">
                  <input
                    id="new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border border-faint rounded-md py-2.5 px-3 pr-10 text-sm focus:border-brand outline-none"
                  />
                  <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
                </div>
                <p className="mt-1 text-[10px] text-faint">At least 8 characters, with a letter and a number.</p>
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-bold text-ink mb-1">Confirm new password</label>
                <div className="relative">
                  <input
                    id="confirm-password"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full border border-faint rounded-md py-2.5 px-3 pr-10 text-sm focus:border-brand outline-none"
                  />
                  <PasswordToggle shown={showConfirm} onToggle={() => setShowConfirm((v) => !v)} />
                </div>
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center py-3 px-4 text-sm font-bold rounded-full text-white bg-brand hover:bg-brand-dark focus:outline-none disabled:opacity-70 transition-colors shadow-sm"
              >
                {isLoading ? 'Resetting…' : 'Reset password'}
              </button>
              <div className="text-center">
                <button type="button" onClick={() => navigate('/login')} className="text-xs font-bold text-brand-dark hover:text-ink transition-colors">
                  Back to sign in
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
