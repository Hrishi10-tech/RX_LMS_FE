import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pagination } from '@/components/ui';
import { useClientPagination } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import {
  FileText, Send, RotateCcw, CheckCircle2, XCircle, ArrowRightCircle, Pencil, Loader2, GitBranch, Undo2, ChevronRight,
} from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';

interface Props {
  /** BOM id when open, null when closed. */
  bomListId: string | null;
  /**
   * Optional version to auto-scroll-to + highlight on open. Set when the
   * version dropdown jumps here for a version that has no sealed snapshot
   * (pre-feature bounce) — the timeline is the only record of what changed.
   */
  focusVersion?: number | null;
  onClose: () => void;
}

/**
 * Visual key per audit action — drives the timeline icon + colour. The
 * map keeps everything in one place so adding a new action only needs
 * a row here (vs. switch statements scattered across the render).
 */
const ACTION_META: Record<string, { icon: any; label: string; tone: string }> = {
  CREATED:          { icon: FileText,        label: 'Created',          tone: 'text-muted bg-hover' },
  ITEMS_EDITED:     { icon: Pencil,          label: 'Items edited',     tone: 'text-muted bg-hover' },
  SUBMITTED:        { icon: Send,            label: 'Submitted',        tone: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-400/20' },
  RECALLED:         { icon: RotateCcw,       label: 'Recalled',         tone: 'text-muted bg-hover' },
  REVISED:          { icon: GitBranch,       label: 'Revised',          tone: 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-400/20' },
  MANAGER_APPROVED: { icon: CheckCircle2,    label: 'Approved',         tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-400/20' },
  LINES_APPROVED:   { icon: CheckCircle2,    label: 'Lines approved',   tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-400/20' },
  LINES_REJECTED:   { icon: XCircle,         label: 'Lines rejected',   tone: 'text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-400/20' },
  REJECTED:         { icon: XCircle,         label: 'Rejected',         tone: 'text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-400/20' },
  ROUTED:           { icon: ArrowRightCircle, label: 'Sent to procurement', tone: 'text-sky-700 dark:text-sky-300 bg-sky-100 dark:bg-sky-400/20' },
  COMPLETED:        { icon: CheckCircle2,    label: 'Completed',        tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-400/20' },
  RETURNED_FOR_REVISION: { icon: Undo2,      label: 'Sent back',        tone: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-400/20' },
  APPROVAL_REVOKED: { icon: RotateCcw,       label: 'Approval revoked', tone: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-400/20' },
};

/**
 * Per-BOM audit timeline — every state transition + items-edit on one
 * BOM, oldest first, with timestamps + performer.
 *
 * User explicitly asked for "version control / tracking with timestamps
 * + UI to access this". This is THAT UI — opened from the approval slip
 * (and later from the editor modal for the requester) via a Timeline
 * button. Append-only on the server side; the drawer is purely visual.
 *
 * Layout: a vertical stripe with a status dot per entry, action label
 * + performer + timestamp, plus a short plain-language detail block below
 * (see TimelineDetail — turns the stored diff into readable facts).
 */
export const BomTimelineDrawer = ({ bomListId, focusVersion, onClose }: Props) => {
  const { addToast } = useToast();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // Per-version-group anchors, so a focusVersion jump can scroll the right
  // group into view once the entries have rendered.
  const groupRefs = useRef<Record<number, HTMLDivElement | null>>({});
  // Expanded edit-clusters, keyed by the cluster's first entry id. Collapsed by
  // default — the pre-submit editing churn isn't something anyone checks unless
  // they're chasing a specific problem, so it stays tucked behind one click.
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const toggleCluster = (key: string) =>
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    if (!bomListId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bomListsApi.timeline(bomListId)
      .then(d => { if (!cancelled) setEntries(d?.items || []); })
      .catch(e => { if (!cancelled) addToast(extractErrorMessage(e, 'Failed to load timeline'), 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads the timeline only when bomListId changes; addToast (toast context) is used only in the error branch and must not retrigger the fetch
  }, [bomListId]);

  // Fold the instant "Sent to procurement" (ROUTED) event into the "Approved"
  // (MANAGER_APPROVED) row that always precedes it — same actor, same moment.
  // The dispatch detail (indent serial + what's issued from stock) becomes the
  // Approved row's detail, so approval + where-it-went read as one beat instead
  // of two near-identical rows. A stray ROUTED with no preceding approval
  // (legacy data) is left as its own row.
  const foldedEntries = useMemo(() => {
    const out: any[] = [];
    for (const e of entries) {
      const prev = out[out.length - 1];
      if (e.action === 'ROUTED' && prev && prev.action === 'MANAGER_APPROVED') {
        out[out.length - 1] = { ...prev, diff: e.diff ?? prev.diff };
        continue;
      }
      out.push(e);
    }
    return out;
  }, [entries]);

  // Split the folded stream into version groups so the auditor reads it as
  // "v1: created → … → sent back · v2: revised → … → approved" instead of one
  // undifferentiated list. Entries arrive oldest-first. A new version begins at
  // each REVISED (revise of an approved BOM — carries the explicit toVersion) or
  // RETURNED_FOR_REVISION (approver bounce — both bump BomList.version on the
  // server). The boundary event itself opens its new version's group.
  const versionGroups = useMemo(() => {
    let v = 1;
    const groups: { version: number; entries: any[] }[] = [];
    for (const e of foldedEntries) {
      if (e.action === 'REVISED') {
        v = (e.diff && typeof e.diff === 'object' && e.diff.toVersion) ? Number(e.diff.toVersion) : v + 1;
      } else if (e.action === 'RETURNED_FOR_REVISION') {
        v = v + 1;
      }
      let g = groups[groups.length - 1];
      if (!g || g.version !== v) { g = { version: v, entries: [] }; groups.push(g); }
      g.entries.push(e);
    }
    return groups;
  }, [foldedEntries]);
  const multiVersion = versionGroups.length > 1;

  // Flatten the version groups into one chronological list of render rows,
  // each tagged with its version and whether it's the first row of that
  // version, so the auditor's grouping (version headers) survives paging while
  // the DOM stays bounded. buildRows (edit-cluster folding) runs per group up
  // front so paging slices finished rows rather than raw entries.
  const flatRows = useMemo(() => {
    const out: { version: number; firstOfVersion: boolean; row: TimelineRow }[] = [];
    for (const group of versionGroups) {
      const rows = buildRows(group.entries);
      rows.forEach((row, i) => {
        out.push({ version: group.version, firstOfVersion: i === 0, row });
      });
    }
    return out;
  }, [versionGroups]);

  // Page the flattened rows at 15/page. Reset key is the BOM id so switching
  // BOMs starts back at page 1.
  const pager = useClientPagination(flatRows, 15, bomListId ?? undefined);

  // When opened with a focusVersion (dropdown jump for a snapshot-less
  // version), jump to the page holding that version's first row, then scroll
  // its group into view once it has rendered.
  useEffect(() => {
    if (loading || focusVersion == null) return;
    const idx = flatRows.findIndex((f) => f.version === focusVersion);
    if (idx < 0) return;
    const targetPage = Math.floor(idx / pager.pageSize) + 1;
    if (targetPage !== pager.page) { pager.setPage(targetPage); return; }
    const el = groupRefs.current[focusVersion];
    if (el) {
      const t = setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pager.setPage/pageSize are stable; re-running on pager.page is what lets the scroll fire once the target page is active
  }, [loading, focusVersion, flatRows, pager.page]);

  return (
    <Modal isOpen={!!bomListId} onClose={onClose} title="BOM Timeline">
      {loading && (
        <div className="flex items-center justify-center py-12 text-faint">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading timeline…
        </div>
      )}
      {!loading && entries.length === 0 && (
        <div className="text-center text-faint py-8 text-sm italic">
          No timeline entries yet.
        </div>
      )}
      {!loading && versionGroups.length > 0 && (
        <div className="space-y-4">
          <p className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Oldest first
            {multiVersion && <> · {versionGroups.length} versions</>}
          </p>
          {/* Regroup the current page's flat rows into contiguous version runs so
              version headers + the ring/scroll anchor survive paging. A version
              spanning a page boundary simply renders as two runs (one per page). */}
          {toPageBlocks(pager.pageRows).map((block, bi) => (
            <div
              key={`${block.version}:${bi}`}
              ref={block.firstOfVersion ? (el) => { groupRefs.current[block.version] = el; } : undefined}
              className={`space-y-2 rounded ${
                focusVersion === block.version
                  ? 'ring-2 ring-violet-300 bg-violet-50/40 dark:bg-violet-400/15 -mx-2 px-2 py-1'
                  : ''
              }`}
            >
              {/* Version divider — only when the BOM was actually revised, so a
                  never-revised BOM reads as a plain single list. */}
              {multiVersion && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30 shrink-0">
                    Version {block.version}{!block.firstOfVersion && <> (cont.)</>}
                  </span>
                  <div className="flex-1 h-px bg-line" />
                </div>
              )}
              <div className="relative pl-7 space-y-4">
                {/* Vertical stripe behind the dots. */}
                <div className="absolute left-3 top-2 bottom-2 w-px bg-line" />
                {block.rows.map((row) => {
                  if (row.kind === 'entry') return <EntryRow key={row.entry.id} entry={row.entry} />;
                  // A run of consecutive edits — one collapsed row + an expand
                  // toggle that reveals each individual change on demand.
                  const key = `${block.version}:${row.entries[0].id}`;
                  const open = expandedClusters.has(key);
                  const last = row.entries[row.entries.length - 1];
                  return (
                    <div key={key} className="relative">
                      <div className="absolute -left-7 top-0.5 w-6 h-6 rounded-full flex items-center justify-center text-muted bg-hover">
                        <Pencil size={12} />
                      </div>
                      <div className="text-sm">
                        <button
                          type="button"
                          onClick={() => toggleCluster(key)}
                          className="flex items-center gap-2 flex-wrap w-full text-left hover:opacity-80"
                        >
                          <span className="font-bold text-ink">Items edited</span>
                          <span className="text-xs text-muted">{row.entries.length} changes</span>
                          <ChevronRight
                            size={12}
                            className={`text-faint transition-transform ${open ? 'rotate-90' : ''}`}
                          />
                          <span className="text-[10px] text-faint ml-auto">last {fmtDateTime(last.createdAt)}</span>
                        </button>
                        {open && (
                          <ul className="mt-1 space-y-1 border-l border-line pl-3">
                            {row.entries.map((e: any) => (
                              <li key={e.id} className="flex items-baseline gap-2 text-xs text-muted">
                                <span className="flex-1">{e.notes || 'Edited items'}</span>
                                <span className="text-[10px] text-faint shrink-0">{fmtDateTime(e.createdAt)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {pager.totalPages > 1 && (
            <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
          )}
        </div>
      )}
    </Modal>
  );
};

/**
 * System-authored notes we DON'T print verbatim — the stored text just restates
 * the action label and leaks internal phrasing (raw status enums like "DRAFT",
 * role names, "must be re-approved from scratch"). Genuine user notes — a
 * manager's approval comment, a rejection reason, a send-back note — always show.
 *
 * Two actions are always system-authored (REVISED, APPROVAL_REVOKED), matched by
 * action. Two others are dual: self-approve MANAGER_APPROVED and the indent-layer
 * RETURNED_FOR_REVISION bounce only write boilerplate when the actor typed
 * nothing, so those are matched by the known boilerplate prefix — anything else
 * is a real note and stays. Prefix-matching (rather than a diff-shape check) is
 * what lets HISTORICAL rows, whose boilerplate is already baked into the string
 * column, read cleanly without a data migration.
 */
const SYSTEM_NOTE_PREFIXES = [
  'Self-approved', // MANAGER_APPROVED — approval-level role, no separate approver
  'Sent back to the requester after indent line review', // RETURNED_FOR_REVISION indent bounce, no note typed
];
const isSystemNote = (action: string, notes?: string | null): boolean => {
  if (action === 'REVISED' || action === 'APPROVAL_REVOKED') return true;
  return typeof notes === 'string' && SYSTEM_NOTE_PREFIXES.some((p) => notes.startsWith(p));
};

/**
 * The detail block under a timeline entry. Instead of dumping every stored key
 * as an uppercase KEY: value pair, it turns the structured diff into a short,
 * consistent set of plain-language facts — using the same words the rest of the
 * app does ("line items", "indent", "issue from stock") — and shows the user's
 * own note when there is one.
 */
const TimelineDetail = ({ action, notes, diff }: { action: string; notes?: string | null; diff?: any }) => {
  const d = diff && typeof diff === 'object' ? diff : {};
  const facts: ReactNode[] = [];

  // Created — the BOM's name.
  if (typeof d.name === 'string' && d.name.trim()) {
    facts.push(<li key="name">Named “{d.name.trim()}”</li>);
  }

  // Submitted — line-item count (+ any custom lines) and the estimated total.
  if ('itemCount' in d || 'estimatedGrandTotal' in d) {
    const parts: string[] = [];
    const items = Number(d.itemCount) || 0;
    const custom = Number(d.customItemCount) || 0;
    if (items > 0) {
      parts.push(`${items} line item${items === 1 ? '' : 's'}${custom > 0 ? ` (${custom} custom)` : ''}`);
    }
    if (typeof d.estimatedGrandTotal === 'number' && d.estimatedGrandTotal > 0) {
      parts.push(`est. ₹${d.estimatedGrandTotal.toLocaleString('en-IN')}`);
    }
    if (parts.length) facts.push(<li key="submit">{parts.join(' · ')}</li>);
  }

  // Where the approved lines went (folded onto the Approved row). The out-of-
  // stock + custom lines become a procurement indent that is NOT ordered on
  // approval — it lands with the department admin for tech approval first (the
  // manager's BOM approval only governs what happens before procurement). Any
  // in-stock lines go to inventory to be issued from stock.
  if ('spawnedIndentId' in d || 'spawnedRequestIds' in d) {
    const reqCount = Array.isArray(d.spawnedRequestIds) ? d.spawnedRequestIds.length : 0;
    const clauses: string[] = [];
    if (d.spawnedIndentId) {
      const label = d.spawnedIndentSerial ? `Indent ${d.spawnedIndentSerial}` : 'A procurement indent';
      clauses.push(`${label} raised, awaiting tech approval from the department admin`);
    }
    if (reqCount > 0) {
      clauses.push(`${reqCount} item${reqCount === 1 ? '' : 's'} to issue from stock`);
    }
    if (clauses.length) {
      const sentence = clauses.join(' · ');
      facts.push(<li key="route">{sentence.charAt(0).toUpperCase() + sentence.slice(1)}.</li>);
    }
  }

  // Rejected lines behind a send-back — the line + why.
  if (Array.isArray(d.rejected)) {
    d.rejected.forEach((r: any, i: number) => {
      facts.push(
        <li key={`rej${i}`}>
          <span className="font-bold text-red-700 dark:text-red-300">Rejected</span>{' '}
          <span className="font-bold text-ink">{r?.name ?? 'line'}</span>
          {r?.reason ? <> — “{r.reason}”</> : null}
        </li>,
      );
    });
  }

  // Whole-batch line verdict (no per-line breakdown) — just the count.
  if (typeof d.count === 'number' && d.count > 0 && !('rejected' in d)) {
    const verb = action === 'LINES_REJECTED' ? 'rejected' : 'approved';
    facts.push(<li key="count">{d.count} line{d.count === 1 ? '' : 's'} {verb}</li>);
  }

  // A live indent torn down by this action (revise / send-back / revoke).
  if (d.cancelledIndentSerial) {
    facts.push(<li key="cancel">Indent {d.cancelledIndentSerial} cancelled.</li>);
  }

  // Requests that were already issued when the teardown ran. They are left
  // with the requester rather than rejected, so say so — otherwise the
  // timeline reads as if everything from this version was cancelled.
  if (Array.isArray(d.issuedRequestsLeftAlone) && d.issuedRequestsLeftAlone.length > 0) {
    const issued = d.issuedRequestsLeftAlone
      .map((r: any) => `${r?.serialNo ?? 'request'} (${String(r?.status ?? '').replace(/_/g, ' ').toLowerCase()})`)
      .join(', ');
    facts.push(<li key="leftAlone">Already issued, so not cancelled: {issued}.</li>);
  }

  // Self-approve — swap the leaky boilerplate note for one plain line that
  // explains why there's no separate approver on the record.
  if (action === 'MANAGER_APPROVED' && typeof notes === 'string' && notes.startsWith('Self-approved')) {
    facts.push(<li key="self">Self-approved — no separate approval needed.</li>);
  }

  const showNote = !!notes && !isSystemNote(action, notes);
  if (!showNote && facts.length === 0) return null;

  return (
    <div className="mt-0.5 space-y-1">
      {showNote && <p className="text-xs text-muted italic">{notes}</p>}
      {facts.length > 0 && (
        <ul className="text-[11px] text-muted space-y-0.5 leading-relaxed">{facts}</ul>
      )}
    </div>
  );
};

/** One timeline row: status dot + action label + actor + timestamp + detail. */
const EntryRow = ({ entry }: { entry: any }) => {
  const meta = ACTION_META[entry.action] || { icon: FileText, label: entry.action, tone: 'text-muted bg-hover' };
  const Icon = meta.icon;
  return (
    <div className="relative">
      <div className={`absolute -left-7 top-0.5 w-6 h-6 rounded-full flex items-center justify-center ${meta.tone}`}>
        <Icon size={12} />
      </div>
      <div className="text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-ink">{meta.label}</span>
          {entry.performedBy?.name && (
            <span className="text-xs text-muted">
              by <span className="font-bold">{entry.performedBy.name}</span>
              {entry.performedBy.role && (
                <span className="text-[10px] text-faint ml-1">({entry.performedBy.role})</span>
              )}
            </span>
          )}
          <span className="text-[10px] text-faint ml-auto">{fmtDateTime(entry.createdAt)}</span>
        </div>
        <TimelineDetail action={entry.action} notes={entry.notes} diff={entry.diff} />
      </div>
    </div>
  );
};

type TimelineRow =
  | { kind: 'entry'; entry: any }
  | { kind: 'editCluster'; entries: any[] };

/**
 * Fold a version's flat entry list into render rows, collapsing any RUN of
 * consecutive ITEMS_EDITED events into one editCluster. A lone edit stays a
 * normal row (nothing to collapse); a run of 2+ becomes a single expandable
 * summary so a heavily-edited BOM doesn't bury its milestones under hundreds of
 * near-identical "Items edited" rows.
 */
/** A flattened, paged row tagged with its version group. */
type FlatRow = { version: number; firstOfVersion: boolean; row: TimelineRow };

/**
 * Regroup a page slice of flat rows into contiguous version blocks for render.
 * `firstOfVersion` on the block's lead row is preserved so the group's scroll
 * anchor + ring only attach where the version genuinely begins (not on a
 * "(cont.)" continuation carried onto a later page).
 */
const toPageBlocks = (rows: FlatRow[]): { version: number; firstOfVersion: boolean; rows: TimelineRow[] }[] => {
  const blocks: { version: number; firstOfVersion: boolean; rows: TimelineRow[] }[] = [];
  for (const f of rows) {
    const last = blocks[blocks.length - 1];
    if (!last || last.version !== f.version) {
      blocks.push({ version: f.version, firstOfVersion: f.firstOfVersion, rows: [f.row] });
    } else {
      last.rows.push(f.row);
    }
  }
  return blocks;
};

const buildRows = (entries: any[]): TimelineRow[] => {
  const rows: TimelineRow[] = [];
  let run: any[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'entry', entry: run[0] });
    else if (run.length > 1) rows.push({ kind: 'editCluster', entries: run });
    run = [];
  };
  for (const e of entries) {
    if (e.action === 'ITEMS_EDITED') run.push(e);
    else { flush(); rows.push({ kind: 'entry', entry: e }); }
  }
  flush();
  return rows;
};
