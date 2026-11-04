import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Save, Check, Building2, FolderKanban, Database } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { ApprovalPolicyCard } from '../components/ApprovalPolicyCard';
import { useAbortOnUnmount } from '@/hooks';

export const SettingsPage = () => {


  const abortSignal = useAbortOnUnmount();
    const { addToast } = useToast();
    const navigate = useNavigate();

    const [vaultEmail, setVaultEmail] = useState('');
    const [originalEmail, setOriginalEmail] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const { data } = await client.get('/platform-credentials/reset-email', { signal: abortSignal() });
            const email = data?.data?.email || data?.email || '';
            setVaultEmail(email);
            setOriginalEmail(email);
        } catch {
            // Endpoint may 403 if not super admin, or vault not set up
        } finally {
            setLoading(false);
        }
    };

    const saveVaultEmail = async () => {
        if (!vaultEmail.trim() || !vaultEmail.includes('@')) {
            addToast('Enter a valid email address.', 'error');
            return;
        }
        setSaving(true);
        try {
            await client.post('/platform-credentials/reset-email', { email: vaultEmail.trim() });
            setOriginalEmail(vaultEmail.trim());
            addToast('Vault reset email updated.', 'success');
        } catch (err: any) {
            addToast(extractErrorMessage(err, 'Failed to update.'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const hasChanges = vaultEmail.trim() !== originalEmail;

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Settings</h2>
                <p className="text-sm md:text-[15px] text-muted mt-1.5">Org configuration, master data, and database operations.</p>
            </div>

            {/* Hub — master-data + ops pages moved under Settings to keep the
                top-level sidebar focused on day-to-day work. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                    { name: 'Companies', desc: 'Vendor companies & their details', path: '/super-admin/companies', icon: <Building2 className="w-5 h-5 text-brand-dark" /> },
                    { name: 'Projects', desc: 'Projects that indents & inventory map to', path: '/super-admin/projects', icon: <FolderKanban className="w-5 h-5 text-brand-dark" /> },
                    { name: 'Database Manager', desc: 'Backups, restore & off-site config', path: '/super-admin/database', icon: <Database className="w-5 h-5 text-brand-dark" /> },
                ].map(c => (
                    <button key={c.path} onClick={() => navigate(c.path)}
                        className="text-left bg-card rounded-xl border border-line-soft shadow-sm p-4 hover:border-brand hover:shadow transition-all">
                        <div className="flex items-center gap-2 mb-1">{c.icon}<span className="text-sm font-bold text-ink">{c.name}</span></div>
                        <p className="text-xs text-muted">{c.desc}</p>
                    </button>
                ))}
            </div>

            <ApprovalPolicyCard />

            <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                <div className="px-6 py-4 border-b border-line-soft flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-purple-50 dark:bg-purple-400/15 flex items-center justify-center">
                        <Shield className="w-4 h-4 text-purple-600 dark:text-purple-300" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-ink">Password Vault Configuration</h3>
                        <p className="text-xs text-muted">Configure the email that can reset the procurement vault master password via OTP.</p>
                    </div>
                </div>

                <div className="p-6">
                    {loading ? (
                        <div className="text-sm text-muted">Loading...</div>
                    ) : (
                        <div className="max-w-md space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Authorized Reset Email</label>
                                <p className="text-xs text-faint mb-2">This email will receive OTP codes when procurement requests a vault master password reset.</p>
                                <input
                                    type="email"
                                    value={vaultEmail}
                                    onChange={e => setVaultEmail(e.target.value)}
                                    placeholder="procurement@yourcompany.com"
                                    className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
                                />
                            </div>

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={saveVaultEmail}
                                    disabled={saving || !hasChanges}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                                >
                                    {saving ? <Save className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                    {saving ? 'Saving...' : 'Save'}
                                </button>
                                {!hasChanges && originalEmail && (
                                    <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-300">
                                        <Check className="w-3.5 h-3.5" /> Configured
                                    </span>
                                )}
                            </div>

                            <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-100 dark:border-amber-400/25 rounded-lg p-3 mt-4">
                                <p className="text-xs text-amber-700 dark:text-amber-300">
                                    <span className="font-bold">Note:</span> The SMTP sender email and app password must be configured in the server's environment variables
                                    (<code className="bg-amber-100 dark:bg-amber-400/20 px-1 rounded">VAULT_RESET_EMAIL</code> and <code className="bg-amber-100 dark:bg-amber-400/20 px-1 rounded">VAULT_RESET_EMAIL_PASSWORD</code>).
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
