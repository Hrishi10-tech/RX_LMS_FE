import { useState } from 'react';
import { Eye, EyeOff, Copy, Plus, Trash2, Edit, Upload } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { Modal, Pagination, ColumnFilter } from '@/components/ui';
import { useClientPagination, useTableFilters, FilterSpec } from '@/hooks';
import { VaultCredentialModal } from '../components/VaultCredentialModal';
import { VaultImportModal } from '../components/VaultImportModal';

import { extractErrorMessage } from '@/lib';
interface Credential {
  id: string;
  platform: string;
  loginId: string;
  password: string;
  notes?: string;
}

// A filter on every data column (owner, 27 Oct). Never the password: a
// filter lists its column's values, and those must stay hidden.
const VAULT_FILTER_SPECS: FilterSpec<Credential>[] = [
  { key: 'platform', getValue: (c) => c.platform },
  { key: 'loginId', getValue: (c) => c.loginId },
  { key: 'notes', getValue: (c) => c.notes || '-' },
];

interface VaultCredentialTableProps {
  credentials: Credential[];
  masterPassword: string;
  onRefresh: () => void;
}

export const VaultCredentialTable = ({ credentials, masterPassword, onRefresh }: VaultCredentialTableProps) => {
  const [search, setSearch] = useState('');
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editCredential, setEditCredential] = useState<Credential | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { addToast } = useToast();

  const searched = credentials.filter((c) => {
    const term = search.toLowerCase();
    return c.platform.toLowerCase().includes(term) || c.loginId.toLowerCase().includes(term);
  });
  const f = useTableFilters(searched, VAULT_FILTER_SPECS);
  const filtered = f.filteredRows;

  const pager = useClientPagination<Credential>(filtered, 10, `${search}|${JSON.stringify(f.filters)}`);
  const th = (label: string, key: string) => (
    <th className={`text-left px-4 py-3 font-semibold text-muted ${f.isActive(key) ? 'bg-brand-100' : ''}`}>
      <span className="inline-flex items-center">
        {label}
        <ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} />
      </span>
    </th>
  );

  const togglePassword = (id: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const copyPassword = async (password: string) => {
    try {
      await navigator.clipboard.writeText(password);
      addToast('Password copied to clipboard.', 'success');
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to copy password.'), 'error'); }
  };

  const handleAdd = () => {
    setEditCredential(null);
    setModalOpen(true);
  };

  const handleEdit = (credential: Credential) => {
    setEditCredential(credential);
    setModalOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await client.delete(`/platform-credentials/${deleteTarget.id}`, {
        data: { masterPassword },
      });
      addToast('Credential deleted.', 'success');
      setDeleteTarget(null);
      onRefresh();
    } catch (err: any) {
      addToast(extractErrorMessage(err, 'Failed to delete credential.'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by platform or login ID..."
          className="w-full sm:w-72 px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-muted border border-line rounded-lg hover:bg-surface hover:text-brand hover:border-brand/40 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
          <button
            onClick={handleAdd}
            className="flex items-center gap-2 px-4 py-2 bg-brand text-white text-sm font-semibold rounded-full hover:bg-brand-600 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Credential
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-surface/50">
                <th className="text-left px-4 py-3 font-semibold text-muted w-12">S.No</th>
                {th('Platform', 'platform')}
                {th('Login ID', 'loginId')}
                <th className="text-left px-4 py-3 font-semibold text-muted">Password</th>
                {th('Notes', 'notes')}
                <th className="text-right px-4 py-3 font-semibold text-muted w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted">
                    {credentials.length === 0 ? 'No credentials yet. Add your first one!' : 'No results match your search or filters.'}
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((cred, idx) => (
                  <tr key={cred.id} className="border-b border-line-soft hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 text-muted">{(pager.page - 1) * 10 + idx + 1}</td>
                    <td className="px-4 py-3 font-medium text-ink">{cred.platform}</td>
                    <td className="px-4 py-3 text-ink">{cred.loginId}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {cred.password ? (
                          <>
                            <span className="font-mono text-ink">
                              {visiblePasswords.has(cred.id) ? cred.password : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                            </span>
                            <button
                              onClick={() => togglePassword(cred.id)}
                              className="p-1 text-faint hover:text-brand transition-colors"
                              title={visiblePasswords.has(cred.id) ? 'Hide password' : 'Show password'}
                            >
                              {visiblePasswords.has(cred.id) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-amber-700 dark:text-amber-300 italic font-medium">Not set</span>
                        )}
                        {cred.password && (
                          <button
                            onClick={() => copyPassword(cred.password)}
                            className="p-1 text-faint hover:text-brand transition-colors"
                            title="Copy password"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted max-w-[200px] truncate">{cred.notes || '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEdit(cred)}
                          className="p-1.5 text-faint hover:text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:bg-blue-400/15 rounded-md transition-colors"
                          title="Edit"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(cred)}
                          className="p-1.5 text-faint hover:text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 rounded-md transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2">
          <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
        </div>
      </div>

      {/* Add/Edit Modal */}
      <VaultCredentialModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditCredential(null); }}
        credential={editCredential}
        masterPassword={masterPassword}
        onSuccess={onRefresh}
      />

      {/* Bulk import modal */}
      <VaultImportModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        masterPassword={masterPassword}
        onSuccess={onRefresh}
      />

      {/* Delete Confirmation */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Credential">
        <p className="text-sm text-muted mb-4">
          Are you sure you want to delete the credential for <span className="font-semibold text-ink">{deleteTarget?.platform}</span>? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setDeleteTarget(null)}
            className="px-4 py-2 text-sm text-muted border border-line rounded-lg hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
};
