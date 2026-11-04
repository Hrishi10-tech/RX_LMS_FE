import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { ChevronDown, Filter } from 'lucide-react';

export interface ColumnFilterOption {
  value: string;
  label: string;
}

export interface ColumnFilterProps {
  options: ColumnFilterOption[];
  value: string;
  onChange: (v: string) => void;
  searchable?: boolean;
  /** Label shown for the "clear" / reset option. Defaults to "All". */
  allLabel?: string;
  /**
   * Date-range mode. When supplied, the popup offers a From/To pair instead of
   * a list of values, and `options`/`value` are ignored.
   *
   * A mode on this component rather than a second one beside it: the popup's
   * viewport positioning, outside-click handling and the scroll exemption that
   * stops it closing the moment you scroll its own contents were all fixed
   * here once, and a separate date popover would have to get every one of them
   * right again.
   */
  range?: {
    from: string;
    to: string;
    onChange: (from: string, to: string) => void;
  };
}

const DROPDOWN_WIDTH = 200;
const DROPDOWN_MARGIN = 8;

export function ColumnFilter({
  options,
  value,
  onChange,
  searchable = false,
  allLabel = 'All',
  range,
}: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Recompute the popup's viewport position from the button's bounding rect.
  // Clamps horizontally so the popup doesn't run off the right edge.
  const recomputePosition = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const left = Math.min(r.left, viewportW - DROPDOWN_WIDTH - DROPDOWN_MARGIN);
    setPos({ top: r.bottom + 4, left: Math.max(DROPDOWN_MARGIN, left) });
  };

  useLayoutEffect(() => {
    if (open) recomputePosition();
  }, [open]);

  // Close on outside click + on scroll/resize (so we don't leave the popup hovering
  // somewhere it doesn't belong while the user scrolls the table).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    // The scroll listener is registered in the CAPTURE phase, so it sees every
    // scroll anywhere in the document — including the one inside this popup's
    // own option list. That closed the dropdown the instant you tried to scroll
    // it, which made any filter with more options than fit on screen
    // (trays: 60, item names: up to 500) effectively unusable: you could only
    // ever pick from what was visible without scrolling.
    //
    // Capture is still what we want for the page scroll case — the popup is
    // positioned from the button's viewport rect, so it would otherwise hang
    // detached in mid-air. So keep the listener and exempt its own scroll.
    // Typing in the popup's search box: Safari scrolls the page to keep the
    // focused box in view, and on an iPhone the keyboard opening resizes the
    // viewport. Both closed the dropdown mid-word (29 Oct, WebKit). While focus
    // is inside the popup, follow the button instead of closing.
    const typingInPopup = () => !!popupRef.current?.contains(document.activeElement);
    const onScroll = (e: Event) => {
      if (popupRef.current?.contains(e.target as Node)) return;
      if (typingInPopup()) { recomputePosition(); return; }
      setOpen(false);
    };
    const onResize = () => {
      if (typingInPopup()) { recomputePosition(); return; }
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // Reset search when the dropdown opens.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const cleanStr = (s: string) => s.replace(/[\W_]+/g, '').toLowerCase();
  const searchClean = cleanStr(search);
  const filteredOptions =
    searchable && search
      ? options.filter((o) => cleanStr(o.label).includes(searchClean))
      : options;

  const rangeActive = !!(range && (range.from || range.to));
  const active = range ? rangeActive : !!value;

  return (
    <div ref={rootRef} className="inline-block relative ml-1 font-normal">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        // An icon-only control with no accessible name announced as just
        // "button". And the ACTIVE state was carried by colour alone — a
        // ~1.02:1 header tint — so a filtered column was indistinguishable
        // from an unfiltered one for anyone who can't rely on that hue.
        aria-label={
          rangeActive ? `Filter, currently showing ${range!.from || 'any'} to ${range!.to || 'any'}`
          : value ? `Filter, currently filtered by ${value}`
          : 'Filter this column'
        }
        title={
          rangeActive ? `${range!.from || 'any'} → ${range!.to || 'any'}`
          : value ? `Filtered by ${value}` : 'Filter this column'
        }
        // The glyph stays 12px — a column header has no room for more, and
        // making the button itself bigger would push the header text around.
        // The TAP AREA grows instead, via a transparent pseudo-element that
        // takes no layout space: measured at 15x15 on a phone, which is less
        // than half the 44px Apple asks for and genuinely hard to hit with a
        // thumb. `relative` is what the pseudo-element anchors to.
        className={`relative p-0.5 rounded hover:bg-brand-50 transition-colors
          after:absolute after:-inset-2.5 after:content-[''] ${
          active ? 'text-brand' : 'text-faint'
        }`}
      >
        {/* A filled glyph, not just a tint, so "filtered" survives greyscale
            and low-contrast displays. */}
        {active ? <Filter size={12} fill="currentColor" /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div
          ref={popupRef}
          className="fixed z-[9999] bg-card border border-brand-200 rounded-xl shadow-lg flex flex-col overflow-hidden fade-slide-down"
          style={{
            top: pos.top,
            left: pos.left,
            width: DROPDOWN_WIDTH,
            maxHeight: '50vh',
          }}
        >
          {range ? (
            <div className="p-3 space-y-2">
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wide text-faint mb-1">From</span>
                <input
                  type="date"
                  value={range.from}
                  max={range.to || undefined}
                  onChange={(e) => range.onChange(e.target.value, range.to)}
                  className="w-full border border-line rounded px-2 py-1.5 text-xs outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wide text-faint mb-1">To</span>
                <input
                  type="date"
                  value={range.to}
                  min={range.from || undefined}
                  onChange={(e) => range.onChange(range.from, e.target.value)}
                  className="w-full border border-line rounded px-2 py-1.5 text-xs outline-none focus:border-brand"
                />
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { range.onChange('', ''); setOpen(false); }}
                  className="flex-1 text-xs text-muted border border-line rounded px-2 py-1.5 hover:bg-surface"
                >{allLabel}</button>
                <button
                  onClick={() => setOpen(false)}
                  className="flex-1 text-xs font-bold text-white bg-brand rounded px-2 py-1.5 hover:opacity-90"
                >Done</button>
              </div>
            </div>
          ) : (
          <>
          {searchable && (
            <div className="p-2 border-b border-line-soft bg-surface/50">
              <input
                type="text"
                autoFocus
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-card border border-line rounded px-2 py-1.5 text-xs outline-none focus:border-brand transition-colors"
              />
            </div>
          )}
          <div className="overflow-y-auto flex-1 p-1">
            <button
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs rounded hover:bg-surface mb-1 ${
                !value
                  ? 'font-bold text-brand bg-brand/5'
                  : 'text-muted'
              }`}
            >
              {allLabel}
            </button>
            {filteredOptions.length === 0 && (
              <div className="px-3 py-2 text-xs text-faint text-center">
                No matches
              </div>
            )}
            {filteredOptions.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs rounded hover:bg-surface mb-0.5 ${
                  value === o.value
                    ? 'font-bold text-brand bg-brand/5'
                    : 'text-ink'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
}
