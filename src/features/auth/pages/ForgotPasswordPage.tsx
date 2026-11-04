import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/auth.api';

/**
 * Unauthenticated "forgot password" step 1: enter your email to get a reset
 * link. The server never reveals whether the email exists, so on success we
 * always show the same generic confirmation.
 */
export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email.'); return; }
    setIsLoading(true);
    setError(null);
    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err: any) {
      // Rate-limit or transient error — the happy path never rejects.
      setError(err?.message || 'Something went wrong. Try again in a moment.');
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
          <h2 className="text-xl md:text-2xl tracking-tight text-center font-bold text-ink">Forgot password</h2>
          <p className="mt-2 text-sm text-muted text-center font-medium">We'll email you a link to reset it.</p>

          {sent ? (
            <div className="mt-8 space-y-4 text-center">
              <div className="bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-md p-4 text-sm text-emerald-800 dark:text-emerald-200">
                If an account exists for <span className="font-bold">{email.trim()}</span>, a reset link has been sent. It's valid for 1 hour.
              </div>
              <p className="text-xs text-faint">Didn't get it? Check spam. A new link can be sent 15 minutes after the last one.</p>
              <button onClick={() => navigate('/login')} className="w-full py-3 px-4 text-sm font-bold rounded-full text-white bg-brand hover:bg-brand-dark transition-colors shadow-sm">
                Back to sign in
              </button>
            </div>
          ) : (
            <form noValidate className="mt-8 space-y-4 md:space-y-6" onSubmit={handleSubmit}>
              {error && (
                <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-3 text-sm text-red-700 dark:text-red-300">{error}</div>
              )}
              <div>
                <label htmlFor="email" className="block text-sm font-bold text-ink mb-1">Email address</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full border border-faint rounded-md py-2.5 px-3 text-sm focus:border-brand outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center py-3 px-4 text-sm font-bold rounded-full text-white bg-brand hover:bg-brand-dark focus:outline-none disabled:opacity-70 transition-colors shadow-sm"
              >
                {isLoading ? 'Sending…' : 'Send reset link'}
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
