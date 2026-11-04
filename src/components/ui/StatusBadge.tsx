import { statusClasses, statusLabel } from './statusStyles';

// Thin presentational wrapper over the canonical status maps (see
// ./statusStyles). Renders one pill in the shared tone + wording; a null
// status shows a neutral "N/A". Compact one-off chips that can't use the full
// badge (e.g. the BOM slip's per-line status cell) call statusClasses /
// statusLabel directly so every surface stays colour- and label-consistent.
export const StatusBadge = ({ status }: { status: string | null }) => {
  if (!status) return <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full ring-1 ring-inset whitespace-nowrap bg-surface text-secondary ring-muted/20">N/A</span>;

  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full ring-1 ring-inset whitespace-nowrap ${statusClasses(status)}`}>
      {statusLabel(status)}
    </span>
  );
};
