import type { ComponentType } from 'react';

interface StatCardProps {
  label: string;
  value: any;
  icon: ComponentType<{ className?: string }>;
  /** Tailwind bg+text classes for the icon chip, e.g. "bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300". */
  color: string;
  sub?: string;
  onClick?: () => void;
  tooltip?: string;
  /** Highlight tint used for the primary/aggregate card on a dashboard. */
  accent?: boolean;
}

/**
 * Shared dashboard KPI card. Replaces the five near-identical local copies that
 * had drifted in min-height / icon size / value type ramp — one consistent
 * sizing is used here (min-h-[76px], w-10 icon chip, text-xl value). Supports
 * the union of props the copies used (onClick, tooltip, sub, accent).
 */
export const StatCard = ({ label, value, icon: Icon, color, sub, onClick, tooltip, accent }: StatCardProps) => (
  <div
    onClick={onClick}
    title={tooltip}
    className={`rounded-2xl border px-3.5 py-4 flex items-center gap-2.5 min-h-[76px] ${onClick ? 'cursor-pointer interactive' : ''} ${accent ? 'bg-brand/5 border-brand/20' : 'bg-card border-line-soft'}`}
    style={{ boxShadow: 'var(--shadow-card)' }}
  >
    {/* `color` carries the status tone (e.g. "bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300") when
        the card reports one; without it the tile falls back to the brand
        soft-tile — pale gradient ground, saturated icon, faint glow. */}
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${color || 'soft-tile'}`}>
      <Icon className="w-5 h-5" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-xl font-bold tracking-tight text-ink truncate" title={String(value ?? '')}>{value}</p>
      {/* Wraps to a second line instead of hard-truncating. Poppins is a little
          wider than the face this replaced, which pushed "Awaiting Payment" and
          "Approved Spend" over the edge; "Pending Tech Approval" never fit on
          one line in either face. `title` covers anything still clipped at two. */}
      <p className="text-[11px] text-secondary font-medium leading-tight line-clamp-2" title={label}>{label}</p>
      {sub && <p className="text-[10px] text-faint truncate">{sub}</p>}
    </div>
  </div>
);
