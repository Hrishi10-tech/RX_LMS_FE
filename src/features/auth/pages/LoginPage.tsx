import { useState, FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks';
import { rolePathMap } from '@/utils/roleRoutes';
import { authApi } from '../services/auth.api';
import { emailProblem } from '@/lib/passwordRule';

/**
 * Emails offered by the quick-fill panel — one account per role, chosen so a
 * request can be walked end to end.
 *
 * The first three are deliberately all HARDWARE: a request routes to the
 * raiser's own manager and then to an admin who administers that same
 * department, so picking a user, a manager and an admin at random gives a
 * request that stops dead at the first approval. Cibi reports to Sampath,
 * and Abdur administers Hardware, so the chain actually completes:
 *
 *   Cibi raises -> Sampath approves -> Abdur tech-approves
 *     -> Harsha orders -> Sugashini pays -> Teja issues
 *
 * The lower four roles are department-independent, so any of them works with
 * any department.
 *
 * Addresses only — deliberately no passwords: this list is compiled into the
 * public bundle. It is a local-dev convenience (see `showDemoLogins`), so
 * hardcoding real addresses is an acceptable trade-off; edit it if the
 * accounts change.
 *
 * NOTE: v1's data has no LAB user, so that role isn't represented here.
 */
// Local-only password, applied to the quick-fill accounts in the local
// database. See handleQuickAccess.
//
// Decided at BUILD time, not by hostname. Checking the hostname at runtime left
// the list and the password inside the production bundle, where anyone could
// read them — and the Super Admin's address plus the 10-try lockout is enough
// to keep that account locked out. With these constant-false in a production
// build, the bundler drops the strings entirely. The local sandbox sets
// VITE_SHOW_DEMO_LOGINS=true in its own (uncommitted) .env.
const DEMO_LOGINS = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGINS === 'true';
const DEV_PASSWORD = DEMO_LOGINS ? 'password123' : '';

const QUICK_FILL_ACCOUNTS: { label: string; email: string }[] = !DEMO_LOGINS ? [] : [
  // --- the Hardware approval chain, in order ---
  { label: 'User · Dhilip',      email: 'dhilipraj@rhythmrx.ai' },
  { label: 'Manager · Sampath',  email: 'sampath@rhythmrx.ai' },
  { label: 'Admin · Abdur',      email: 'abdur@rhythmrx.ai' },
  // --- cross-department roles ---
  { label: 'Procurement',        email: 'procurement@rhythmrx.ai' },
  { label: 'Finance',            email: 'sugashini@rhythmrx.ai' },
  { label: 'Inventory · Teja',   email: 'teja@rhythmrx.ai' },
  { label: 'Assoc. Finance',     email: 'anushiya@rhythmrx.ai' },
  { label: 'Super Admin',        email: 'admin@rhythmrx.ai' },
];

export const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Demo quick-access buttons: shown when explicitly enabled (DEV or the env
  // flag) or on localhost for the local Docker/UAT build. Never on a real
  // domain unless the flag is set, so prod can't leak them.
  const showDemoLogins = DEMO_LOGINS;

  // Core sign-in, parameterised so both the form submit and the one-click
  // demo buttons share the exact same flow (the demo buttons can't rely on
  // the `email`/`password` state being flushed synchronously after setState).
  const doLogin = async (emailInput: string, passwordInput: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await authApi.login(emailInput, passwordInput);
      login(data);

      // If the user was bounced here mid-session by an expired refresh token,
      // the API interceptor appends ?next=<originalPath>. Honor it so they
      // land back on the page they were working on instead of the role
      // dashboard. Only accept relative paths to avoid open-redirect.
      const params = new URLSearchParams(location.search);
      const next = params.get('next');
      // Only into this person's own area (or the alert redirect). On a shared
      // terminal the `next` left by the previous person's expired session
      // pointed into THEIR pages, and the new person got "Permission denied"
      // instead of their dashboard.
      const home = rolePathMap[data.user.role] || '/';
      const isSafeNext = !!next && next.startsWith('/') && !next.startsWith('//') &&
        (next === home || next.startsWith(`${home}/`) || next.startsWith(`${home}?`) || next.startsWith('/open-notification'));

      // Route based on role (shared map — see utils/roleRoutes).
      navigate(isSafeNext ? next : (rolePathMap[data.user.role] || '/'));
    } catch (err: any) {
      // The axios response interceptor wraps every error in AppError, so
      // the user-visible message lives on `err.message`. Reading from
      // `err.response.data.message` (axios' raw shape) is always
      // `undefined` post-interceptor — that's why every failed login
      // used to show the generic "Failed to login" instead of the
      // actual reason (wrong password, rate-limited, account disabled).
      setError(err?.message || 'Failed to login');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Sign in with what is ON SCREEN, not with what React thinks is there.
    //
    // Browser autofill and password managers write straight into an input's
    // `value` without firing React's `onChange`, so `email`/`password` state
    // can still be empty strings while the two fields visibly hold
    // credentials. `required` validates the DOM value — which IS filled — so
    // the form submitted happily and the server received two empty strings:
    // a filled-in login form rejected with "Invalid email or password", and
    // nothing on screen to explain why. Reading the inputs back off the form
    // keeps state and DOM in step whoever filled them in.
    const fields = new FormData(e.currentTarget);
    const submittedEmail = String(fields.get('email') ?? '').trim() || email;
    // Not trimmed — trailing whitespace is legal in a password.
    const submittedPassword = String(fields.get('password') ?? '') || password;

    // Adopt them so the controlled inputs don't blank themselves on the next
    // render (state '' vs a filled DOM node means React clears the field).
    setEmail(submittedEmail);
    setPassword(submittedPassword);

    // The app's own message, not the browser's "Please fill out this field".
    const emailErr = emailProblem(submittedEmail);
    if (emailErr) { setError(emailErr); return; }
    if (!submittedPassword) { setError('Enter your password.'); return; }

    await doLogin(submittedEmail, submittedPassword);
  };

  // One-click sign-in for the local role-switching panel.
  //
  // DEV_PASSWORD is not any real account's password. The eight quick-fill
  // accounts have it set on THIS machine's database only, purely so roles can
  // be switched while testing; the deployed server's passwords are untouched
  // and are not in this bundle. The panel is localhost-gated (see
  // `showDemoLogins`), so none of this reaches a real domain.
  const handleQuickAccess = (emailInput: string) => {
    setEmail(emailInput);
    setPassword(DEV_PASSWORD);
    doLogin(emailInput, DEV_PASSWORD);
  };

  return (
    <div className="bg-hero-vivid min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 font-sans">
      {/* Circular logo badge, sitting above the card and overlapping nothing —
          the mark reads on the gradient without needing a panel behind it. */}
      <div className="mb-6 h-20 w-20 rounded-full bg-card shadow-[0_8px_24px_rgba(0,0,0,0.18)] flex items-center justify-center shrink-0 pop-in">
        <span className="text-brand font-extrabold text-xl tracking-tight">LMS</span>
      </div>

      <div className="w-full max-w-md bg-card p-6 md:p-9 rounded-3xl shadow-[0_18px_50px_rgba(0,0,0,0.18)] enter-up">
          <div>
            <h2 className="text-xl md:text-2xl tracking-tight text-center font-bold text-ink">
              Sign in
            </h2>
            <p className="mt-1.5 text-sm text-muted text-center font-medium">
              Lab Management System
            </p>
          </div>
          <form noValidate className="mt-8 space-y-4 md:space-y-6" onSubmit={handleLogin}>
            {error && (
              <div role="alert" className="bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 p-3 rounded-xl text-sm font-medium border border-red-200 dark:border-red-400/30">
                {error}
              </div>
            )}
            {/* Labelled fields rather than placeholder-only. A placeholder
                disappears the moment you type, so the only cue for what a
                half-filled box holds was its position; the label stays. */}
            <div className="space-y-4">
              <div>
                <label htmlFor="email-address" className="block text-[13px] font-semibold text-ink mb-1.5">
                  Email
                </label>
                {/* autoComplete="username" is what tells Chrome / 1Password /
                    Bitwarden that this is the username field for credential
                    storage. Without it, the password-save prompt usually
                    doesn't fire on SPA logins.

                    On everywhere, including local builds — deliberately
                    re-enabled, having previously been off wherever the demo
                    panel shows.

                    KNOWN TRADE-OFF, kept here because it will look like a bug
                    otherwise: browsers scope saved passwords to the HOST and
                    ignore the port, so every app on localhost shares one
                    credential pile. A login saved against the real app on
                    :5173 will autofill into this sandbox and be rejected,
                    because that account doesn't exist in this database. That
                    is the autofill working as designed, not a broken login —
                    clear the box, or use the one-click demo buttons below,
                    which bypass the form entirely. */}
                <input
                  id="email-address"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  className="input-glass block w-full px-4 py-3 rounded-xl text-ink placeholder-faint text-sm"
                  placeholder="you@rhythmrx.ai"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-[13px] font-semibold text-ink mb-1.5">
                  Password
                </label>
                <div className="relative">
                  {/* autoComplete="current-password" → autofill prompt for an
                      existing login. (Use "new-password" only on signup /
                      change-password forms.)

                      This used to be "new-password" on local builds purely to
                      stop Chrome injecting a stored password — see the note on
                      the email field above. That had a side effect worth
                      remembering: with "new-password", Chrome treats a save
                      prompt as setting a NEW credential for the host, so
                      accepting it overwrites the existing saved entry rather
                      than matching it. */}
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    className="input-glass block w-full px-4 py-3 pr-11 rounded-xl text-ink placeholder-faint text-sm"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {/* Icon-only, so it carries its own name; `aria-pressed`
                      reports which state it is in rather than leaving a
                      screen reader to infer it from the glyph. */}
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-faint hover:text-brand transition-colors rounded-r-xl"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-bold rounded-full text-white bg-brand disabled:opacity-70"
              >
                {isLoading ? 'Signing in...' : 'Sign in'}
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                onClick={() => navigate('/forgot-password')}
                className="text-xs font-bold text-brand hover:text-brand-dark transition-colors"
              >
                Forgot password?
              </button>
            </div>
          </form>

          {/* Quick-access buttons for testing — gated to an explicit env
              flag (not NODE_ENV) so we can keep them in a prod-built
              container during UAT, then flip the var off + redeploy
              before going live. Also shown automatically on localhost so the
              local Docker/UAT build has them without extra config; they never
              appear on a real (non-localhost) domain unless the flag is set. */}
          {showDemoLogins && (
          <div className="mt-8 pt-6 border-t border-line">
            <p className="text-sm font-bold text-muted mb-1 text-center">Quick sign-in</p>
            <p className="text-[10px] text-faint text-center mb-3">
              Local testing only. The first three are all Hardware, so a request raised by Cibi
              routes to Sampath then Abdur.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {QUICK_FILL_ACCOUNTS.map(a => (
                <button
                  key={a.email}
                  type="button"
                  onClick={() => handleQuickAccess(a.email)}
                  title={a.email}
                  className="border border-line text-muted py-1.5 px-2 rounded-full hover:border-brand hover:text-brand hover:bg-brand-50 font-bold transition-colors truncate"
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          )}
      </div>
    </div>
  );
};
