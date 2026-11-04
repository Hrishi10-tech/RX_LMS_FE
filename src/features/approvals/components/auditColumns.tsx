import { Eye, Clock } from 'lucide-react';

/**
 * Shared View + Track audit actions for every approvals table — indents and
 * component requests, across the super-admin / admin / manager lenses. Returns
 * two icon-only columns:
 *   - "View"  (Eye)   → opens the read-only detail modal
 *   - "Track" (Clock) → opens the status / approval timeline
 *
 * The column header carries the word ("View" / "Track") so the bare icon in
 * each cell reads cleanly without crowding the action area with text buttons.
 * Centralised here so all five approvals tables stay consistent (and so the
 * Track icon can never drift back to an Eye, which it had on several tables).
 *
 * Callers pass the two open-handlers; row shape is `any` to match the
 * surrounding DataTable column definitions.
 */
export const auditColumns = (
  onView: (row: any) => void,
  onTrack: (row: any) => void,
): any[] => [
  {
    header: 'View',
    accessor: (row: any) => (
      <button
        onClick={() => onView(row)}
        title="View full details"
        className="inline-flex items-center justify-center text-muted hover:text-ink p-1.5 rounded hover:bg-hover transition-colors"
      >
        <Eye size={16} />
      </button>
    ),
  },
  {
    header: 'Track',
    accessor: (row: any) => (
      <button
        onClick={() => onTrack(row)}
        title="Timeline — see who acted when, and where it stalled"
        className="inline-flex items-center justify-center text-brand hover:text-brand-dark p-1.5 rounded hover:bg-brand/10 transition-colors"
      >
        <Clock size={16} />
      </button>
    ),
  },
];
