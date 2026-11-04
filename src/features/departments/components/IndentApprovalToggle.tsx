import { IndentApprovalMode } from '@/types';
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from '../approval-modes';

interface Props {
  departmentName: string;
  value?: IndentApprovalMode;
  /** Saves immediately — there is no form around this and no Save button. */
  onChange: (mode: IndentApprovalMode) => void;
  isSaving: boolean;
}

/**
 * Which signatures an indent needs, set from the department row itself.
 *
 * This used to live inside the Edit dialog, which meant the answer for every
 * department was three clicks away and invisible until you went looking. In a
 * list of departments the setting IS the interesting column, so it sits in the
 * row and reads at a glance.
 *
 * Drawn as a segmented control with a sliding thumb rather than two equally
 * weighted buttons: the first version made both options look pressable-and-
 * identical, so the row read as a pair of stray buttons rather than as one
 * setting with a current value. The two cells are a 2-column grid so they are
 * exactly equal width, and the thumb moves by 100% of itself and lands
 * perfectly.
 *
 * Both labels keep the SAME font weight. Bolding only the chosen one re-sizes
 * the grid columns, so the whole control changed width with the selection and
 * the rows stopped lining up down the column — measured 539.2 against 533.5
 * on neighbouring rows. The thumb carries the selection; colour does the rest.
 */
export const IndentApprovalToggle = ({ departmentName, value, onChange, isSaving }: Props) => {
  const current = value || DEFAULT_APPROVAL_MODE;
  const activeIndex = Math.max(0, APPROVAL_MODES.findIndex((m) => m.value === current));

  return (
    <div className="inline-flex shrink-0 items-center">
      <div
        role="group"
        aria-label={`Manager approval for ${departmentName}`}
        aria-busy={isSaving}
        className={`relative grid grid-cols-2 rounded-full border border-line-soft bg-surface p-[3px] transition-opacity ${
          isSaving ? 'opacity-60' : ''
        }`}
      >
        {/* The thumb. `inset-y-[3px] left-[3px] w-[calc(50%-3px)]` is the first
            cell exactly; translating by 100% of its own width lands it on the
            second. Decorative — the state lives on aria-pressed. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-full bg-brand shadow-sm transition-transform duration-200 ease-out"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
        {APPROVAL_MODES.map((m, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={m.value}
              type="button"
              aria-pressed={active}
              disabled={isSaving}
              title={m.detail}
              onClick={() => !active && onChange(m.value)}
              className={`relative z-10 whitespace-nowrap rounded-full px-3.5 py-1 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait ${
                active ? 'text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {m.short}
            </button>
          );
        })}
      </div>
    </div>
  );
};
