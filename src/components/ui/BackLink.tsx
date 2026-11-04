import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Props {
  /** Explicit destination. If omitted, goes back one step in browser history. */
  to?: string;
  label?: string;
  className?: string;
}

/**
 * Small "← Back" / "← Settings" link for pages that no longer have a top-level
 * sidebar entry (e.g. Companies / Projects / Database Manager now live under
 * Settings). Pass `to` for a deterministic destination, or omit it to go back.
 */
export const BackLink = ({ to, label = 'Back', className = '' }: Props) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => (to ? navigate(to) : navigate(-1))}
      className={`inline-flex items-center gap-1 text-xs font-bold text-muted hover:text-ink transition-colors ${className}`}
    >
      <ChevronLeft className="w-4 h-4" /> {label}
    </button>
  );
};
