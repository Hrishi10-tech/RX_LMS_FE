import { useEffect, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDateTime } from '@/utils/date';
import { Check, X, Clock, AlertCircle, FileText, Send, Trash2 } from 'lucide-react';

import { extractErrorMessage } from '@/lib';
import { UserRole } from '@/types';
import { useAbortOnUnmount } from '@/hooks';
interface AssetApprovalsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApplied: () => void;
    // New: when provided, draft rows show a "Resume editing" button that
    // hands the draft back to the parent's modal-opener so the proposer
    // can pick up where they left off.
    onResumeDraft?: (proposal: Proposal) => void;
    // Which status tab to open on. Defaults to 'PENDING' for the reviewer
    // entry; the "My Drafts" button passes 'DRAFT' so the proposer lands
    // on their drafts immediately.
    initialFilter?: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';
}

interface Proposal {
    id: string;
    fixedAssetId: string | null;
    proposalType: 'CREATE' | 'UPDATE' | 'TRANSFER';
    proposedChanges: Record<string, any>;
    status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
    requestedBy?: { id: string; name: string; email: string } | null;
    reviewedBy?: { id: string; name: string; email: string } | null;
    reviewedAt?: string | null;
    reviewerComment?: string | null;
    fixedAsset?: { id: string; assetTag: string; name: string } | null;
    createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
    DRAFT:    'bg-slate-50 text-slate-700 border-slate-200',
    PENDING:  'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
    APPROVED: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
    REJECTED: 'bg-rose-50 dark:bg-rose-400/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-400/30',
};

// Pretty-print a proposed-changes blob. Each value is just stringified —
// good enough for the queue view; the per-row detail expansion can dive
// deeper later.
const renderChanges = (changes: Record<string, any>) => {
    // locationId is an internal FK (cuid) — meaningless to a human reviewer.
    // The readable `location` name is always sent alongside it, so drop the id.
    const entries = Object.entries(changes || {}).filter(([k]) => k !== 'locationId');
    if (entries.length === 0) return <span className="text-faint italic">(no changes)</span>;
    return (
        <div className="space-y-0.5">
            {entries.map(([k, v]) => (
                <div key={k} className="text-[11px]">
                    <span className="text-muted font-medium">{k}:</span>{' '}
                    <span className="font-medium">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
            ))}
        </div>
    );
};

// Modal-based queue review for fixed-asset proposals. ADMIN/SUPER_ADMIN
// see all (filtered to their dept-scoped assets server-side); other roles
// see only their own submissions. Approve / reject actions only render
// for reviewers on PENDING items.
export const AssetApprovalsModal = ({ isOpen, onClose, onApplied, onResumeDraft, initialFilter = 'PENDING' }: AssetApprovalsModalProps) => {
    const { addToast } = useToast();
    const { user } = useAuth();
    const confirm = useConfirm();
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

    const [proposals, setProposals] = useState<Proposal[]>([]);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState<'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>(initialFilter);

    // When the parent re-opens the modal pointing at a different tab
    // (e.g. switching between My Drafts and Approvals buttons), honour it.
    useEffect(() => {
      if (isOpen) setFilter(initialFilter);
    }, [isOpen, initialFilter]);
    const [actingOn, setActingOn] = useState<string | null>(null);
    const [rejectCommentFor, setRejectCommentFor] = useState<string | null>(null);
    const [rejectText, setRejectText] = useState('');

    // FINANCE is also a reviewer on this queue — finance head approves
    // the associate-finance pipeline (CREATE / UPDATE / TRANSFER on
    // fixed assets). Service-side enforces no-self-approval regardless.
    const isReviewer = user?.role === UserRole.ADMIN || user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.FINANCE;

    const fetchProposals = async () => {
        setLoading(true);
        try {
            const url = filter === 'ALL' ? '/fixed-assets/approvals' : `/fixed-assets/approvals?status=${filter}`;
            const res = await client.get(url, { signal: abortSignal() });
            const raw = res.data?.data ?? res.data ?? [];
            setProposals(Array.isArray(raw) ? raw : []);
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load proposals'), 'error'); } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) fetchProposals();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, filter]);

    const handleApprove = async (id: string) => {
        if (!await confirm('Approve this proposal? The change will apply immediately.')) return;
        setActingOn(id);
        try {
            await client.post(`/fixed-assets/approvals/${id}/approve`, {});
            addToast('Proposal approved + applied', 'success');
            await fetchProposals();
            onApplied();
            // Refresh the FINANCE Fixed Assets sidebar dot (PENDING just dropped).
            window.dispatchEvent(new Event('approvals-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to approve'), 'error');
        } finally {
            setActingOn(null);
        }
    };

    const handleSubmitDraft = async (id: string) => {
        setActingOn(id);
        try {
            await client.post(`/fixed-assets/approvals/${id}/submit`, {});
            addToast('Draft submitted for approval', 'success');
            await fetchProposals();
            // A DRAFT just became PENDING — refresh reviewers' Fixed Assets dot.
            window.dispatchEvent(new Event('approvals-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not submit draft'), 'error');
        } finally {
            setActingOn(null);
        }
    };

    const handleDeleteDraft = async (id: string) => {
        if (!await confirm('Delete this draft? It cannot be recovered.')) return;
        setActingOn(id);
        try {
            await client.delete(`/fixed-assets/approvals/${id}`);
            addToast('Draft deleted', 'success');
            await fetchProposals();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not delete draft'), 'error');
        } finally {
            setActingOn(null);
        }
    };

    const handleReject = async (id: string) => {
        if (!rejectText.trim()) {
            addToast('A rejection reason is required', 'error');
            return;
        }
        setActingOn(id);
        try {
            await client.post(`/fixed-assets/approvals/${id}/reject`, { comment: rejectText.trim() });
            addToast('Proposal rejected', 'success');
            setRejectCommentFor(null);
            setRejectText('');
            await fetchProposals();
            // Refresh the FINANCE Fixed Assets sidebar dot (PENDING just dropped).
            window.dispatchEvent(new Event('approvals-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to reject'), 'error');
        } finally {
            setActingOn(null);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Fixed Asset — Approval Queue">
            <div className="space-y-4">
                {/* Status filter pills */}
                <div className="flex items-center gap-2 border-b border-line-soft pb-3">
                    {(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((s) => (
                        <button
                            key={s}
                            onClick={() => setFilter(s)}
                            className={`text-xs font-bold px-3 py-1 rounded-full border transition-colors ${
                                filter === s
                                    ? 'bg-ink text-card border-ink'
                                    : 'bg-card text-muted border-line hover:border-brand'
                            }`}
                        >
                            {s}
                        </button>
                    ))}
                </div>

                {loading && <p className="text-sm text-faint text-center py-6">Loading…</p>}
                {!loading && proposals.length === 0 && (
                    <div className="flex flex-col items-center py-8 text-center">
                        {filter === 'DRAFT' ? (
                            <>
                                <FileText className="w-10 h-10 text-faint mb-2" />
                                <p className="text-sm text-muted font-bold">No drafts yet.</p>
                                <p className="text-xs text-faint mt-1 max-w-sm">
                                    Click <span className="font-bold">Propose Asset</span> to start one. You can save partial info as a draft and finish it later — drafts appear here only for you.
                                </p>
                            </>
                        ) : (
                            <>
                                <AlertCircle className="w-10 h-10 text-faint mb-2" />
                                <p className="text-sm text-muted">No proposals in this view.</p>
                            </>
                        )}
                    </div>
                )}

                <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                    {proposals.map((p) => {
                        const target = p.fixedAsset ? `${p.fixedAsset.assetTag} — ${p.fixedAsset.name}` : '(new asset)';
                        const canReview = isReviewer && p.status === 'PENDING' && p.requestedBy?.id !== user?.id;
                        return (
                            <div key={p.id} className="border border-line rounded-lg p-3 bg-card">
                                <div className="flex items-start justify-between gap-3 mb-2">
                                    <div>
                                        <p className="text-sm font-bold text-ink">
                                            {p.proposalType} → {target}
                                        </p>
                                        <p className="text-[11px] text-muted flex items-center gap-1 mt-0.5">
                                            <Clock size={10} /> Submitted by {p.requestedBy?.name || 'Unknown'} · {fmtDateTime(p.createdAt)}
                                        </p>
                                    </div>
                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_STYLES[p.status] || 'bg-surface text-secondary border-line'}`}>
                                        {p.status}
                                    </span>
                                </div>

                                <div className="bg-surface rounded p-2 mb-2">
                                    {renderChanges(p.proposedChanges)}
                                </div>

                                {p.status !== 'PENDING' && p.reviewedBy && (
                                    <p className="text-[11px] text-muted">
                                        {p.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {p.reviewedBy.name}
                                        {p.reviewedAt && ` · ${fmtDateTime(p.reviewedAt)}`}
                                        {p.reviewerComment && (
                                            <span className="block italic mt-0.5">"{p.reviewerComment}"</span>
                                        )}
                                    </p>
                                )}

                                {canReview && (
                                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-line-soft">
                                        <button
                                            onClick={() => handleApprove(p.id)}
                                            disabled={actingOn === p.id}
                                            className="text-xs font-bold bg-emerald-700 text-white px-3 py-1 rounded hover:bg-emerald-800 transition-colors disabled:opacity-50 flex items-center gap-1"
                                        >
                                            <Check size={12} /> Approve
                                        </button>
                                        <button
                                            onClick={() => { setRejectCommentFor(p.id); setRejectText(''); }}
                                            disabled={actingOn === p.id}
                                            className="text-xs font-bold border border-red-300 dark:border-red-400/30 text-red-700 dark:text-red-300 px-3 py-1 rounded hover:bg-red-50 dark:bg-red-400/15 transition-colors disabled:opacity-50 flex items-center gap-1"
                                        >
                                            <X size={12} /> Reject
                                        </button>
                                    </div>
                                )}

                                {/* DRAFT actions — only the proposer sees these, server-side
                                    enforces the scope. Resume → opens the modal pre-filled.
                                    Submit → flips DRAFT→PENDING (server validates completeness).
                                    Delete → hard-deletes the draft. */}
                                {p.status === 'DRAFT' && p.requestedBy?.id === user?.id && (
                                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-line-soft">
                                        {onResumeDraft && (
                                            <button
                                                onClick={() => { onResumeDraft(p); onClose(); }}
                                                disabled={actingOn === p.id}
                                                className="text-xs font-bold bg-brand text-white px-3 py-1 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50 flex items-center gap-1"
                                            >
                                                <FileText size={12} /> Resume editing
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleSubmitDraft(p.id)}
                                            disabled={actingOn === p.id}
                                            className="text-xs font-bold border border-emerald-300 dark:border-emerald-400/30 text-emerald-700 dark:text-emerald-300 px-3 py-1 rounded hover:bg-emerald-50 dark:bg-emerald-400/15 transition-colors disabled:opacity-50 flex items-center gap-1"
                                        >
                                            <Send size={12} /> Submit for approval
                                        </button>
                                        <button
                                            onClick={() => handleDeleteDraft(p.id)}
                                            disabled={actingOn === p.id}
                                            className="text-xs font-bold border border-line text-muted px-3 py-1 rounded hover:bg-surface transition-colors disabled:opacity-50 flex items-center gap-1"
                                        >
                                            <Trash2 size={12} /> Delete
                                        </button>
                                    </div>
                                )}

                                {rejectCommentFor === p.id && (
                                    <div className="mt-2 pt-2 border-t border-line-soft space-y-2">
                                        <textarea
                                            value={rejectText}
                                            onChange={(e) => setRejectText(e.target.value)}
                                            rows={2}
                                            placeholder="Reason for rejection (required, shown to requester)…"
                                            className="w-full border border-line rounded px-2 py-1 text-xs focus:border-brand outline-none resize-none"
                                        />
                                        <div className="flex gap-2 justify-end">
                                            <button
                                                onClick={() => { setRejectCommentFor(null); setRejectText(''); }}
                                                className="text-xs font-bold text-muted px-2 py-1 rounded hover:bg-surface"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => handleReject(p.id)}
                                                disabled={!rejectText.trim() || actingOn === p.id}
                                                className="text-xs font-bold bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 transition-colors disabled:opacity-50"
                                            >
                                                Confirm Reject
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </Modal>
    );
};
