interface BomProvenanceChipProps {
  serialNo: string;
  name?: string | null;
  /** Optional text before the serial, e.g. "from " → "📦 from BOM-005". */
  prefix?: string;
}

/**
 * The amber "📦 Bundled from BOM …" provenance pill shown on indent rows that
 * were bundled out of a BOM list. Replaces the identical copies on the approval
 * / finance tables. (The distinct emerald "📋" stock-up variant on the indents
 * management table intentionally stays local — different tone and semantics.)
 */
export const BomProvenanceChip = ({ serialNo, name, prefix = '' }: BomProvenanceChipProps) => (
  <span
    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-brand-100 text-brand-700 border border-brand-200"
    title={`Bundled from BOM ${serialNo}${name ? ' — ' + name : ''}`}
  >
    📦 {prefix}{serialNo}
  </span>
);
