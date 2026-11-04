import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional action(s) rendered in the header, immediately left of the
   *  close (✕) button — e.g. a "Timeline" button. Keeps per-modal chrome
   *  on the title row instead of pushing it into the body. */
  headerRight?: ReactNode;
  /** Panel max-width. Defaults to 'md' (max-w-lg) so existing modals are
   *  unchanged. Data-heavy modals (e.g. the indent quotation slip with ~9
   *  columns) can open wider to avoid horizontal scrolling. The panel stays
   *  `w-full` underneath, so it shrinks responsively on smaller screens. */
  size?: ModalSize;
}

// Full class strings (not interpolated fragments) so Tailwind's JIT scanner
// detects and emits each one.
const SIZE_MAX_W: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg', // current default — unchanged
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
  '3xl': 'max-w-7xl',
  full: 'max-w-[95vw]',
};

/**
 * Tracks nested modal stacks so Escape only closes the topmost one.
 * Without this, opening a child modal (e.g. Timeline drawer over the
 * approval slip) → pressing Escape would close BOTH layers because
 * both modals' Escape handlers fire on the same keydown event.
 *
 * Each open modal pushes an entry onto the stack; the global keydown
 * handler invokes only the last (top) one. Stack lives at module scope
 * so it's shared across every Modal instance.
 *
 * Entries also expose `isDirty` so Escape can refuse to discard a form
 * the user has already started filling in — see the handler below.
 */
type ModalStackEntry = { close: () => void; isDirty: () => boolean };
const modalStack: Array<ModalStackEntry> = [];
let globalKeydownAttached = false;
const attachGlobalKeydownIfNeeded = () => {
  if (globalKeydownAttached) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    e.preventDefault();
    e.stopPropagation();
    // Escape is a convenience for dismissing a modal opened by mistake.
    // Once anything has been typed or selected, the panel holds work in
    // progress (these are long forms — indents, component requests, BOM
    // slips), so swallow the key instead of throwing the form away. A
    // dirty modal closes only by an explicit act: the ✕ or Cancel.
    if (top.isDirty()) return;
    top.close();
  });
  globalKeydownAttached = true;
};

/**
 * Browser Back closes the topmost modal instead of leaving the page.
 *
 * Opening a modal does not change the URL, so Back used to navigate away from
 * the page underneath — taking a half-filled indent or component request with
 * it. On a phone, where Back is the system gesture and there is no visible ✕
 * until you scroll, that is the obvious way to dismiss a panel and it threw
 * the form away every time.
 *
 * Each open modal pushes one history entry so Back has something of its own to
 * consume. The semantics match Escape deliberately: a clean modal closes, and
 * a dirty one refuses and puts its entry back, because the alternative is
 * silently discarding work the user has already done. Any modal that refuses
 * still closes by an explicit act — the ✕ or Cancel.
 */
let globalPopstateAttached = false;
/**
 * popstate events this component caused itself, which must not be read as the
 * user pressing Back.
 *
 * Closing a modal by ✕ or Cancel unwinds its own guard entry with
 * `history.back()`. That fires popstate like any other, and without this the
 * handler would treat it as a Back press and close whatever modal is now on
 * top — which broke every chained flow in the app, where one panel closes to
 * open the next (create a BOM list, the editor opens; pick a vendor, the
 * shipment tracker opens).
 */
let selfInflictedPops = 0;
const attachGlobalPopstateIfNeeded = () => {
  if (globalPopstateAttached) return;
  window.addEventListener('popstate', () => {
    if (selfInflictedPops > 0) { selfInflictedPops -= 1; return; }
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (top.isDirty()) {
      // Put the guard entry back, so the next Back is also absorbed rather
      // than falling through to the page behind.
      window.history.pushState({ modalGuard: true }, '');
      return;
    }
    top.close();
  });
  globalPopstateAttached = true;
};

export const Modal = ({ isOpen, onClose, title, children, size = 'md', headerRight }: ModalProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Hold onClose in a ref so the stack-management useEffect doesn't
  // re-fire on every parent render — most callers pass an inline arrow
  // for onClose, so its reference is new each render. Without this ref,
  // the focus-restore microtask was firing on every keystroke in any
  // input inside the modal, yanking focus back to the first focusable.
  // That manifested as "I type a digit and the field loses focus".
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // "Has the user changed anything in here?" — drives the Escape guard.
  // Native `input`/`change` events fire only for real user interaction;
  // React writing a default or prefilled value sets the DOM property
  // directly and dispatches nothing, so prefilled forms don't count as
  // dirty. Non-form modals (confirmations, viewers) never go dirty and
  // so keep closing on Escape as before.
  const dirtyRef = useRef(false);

  // Stacking depth = how many modals were already open when this one opened.
  // Drives a per-layer z-index (below) so a child modal opened FROM another
  // modal (e.g. the Track timeline launched from the Indent History modal)
  // always paints above its parent instead of relying on JSX declaration
  // order. 0 for a lone/base modal → unchanged z-50.
  const [depth, setDepth] = useState(0);

  // Push/pop on the global modal stack so Escape closes only the topmost
  // modal. Also remember the previously-focused element so we can return
  // focus there on close (accessibility — screen readers + keyboard users
  // expect focus to come back to whatever opened the modal).
  // Deps: ONLY isOpen — onClose is read from the ref above.
  useEffect(() => {
    if (!isOpen) return;
    attachGlobalKeydownIfNeeded();
    attachGlobalPopstateIfNeeded();
    // One history entry per open modal, so Back has something to consume
    // that is not the page underneath.
    window.history.pushState({ modalGuard: true }, '');
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Capture how many modals are already open BEFORE pushing — that count is
    // this modal's stacking depth (0 = first/base layer).
    setDepth(modalStack.length);
    // A reopened modal is clean again — reset before pushing.
    dirtyRef.current = false;
    // Stable entry object; its closures always read the latest onClose.
    const stackEntry: ModalStackEntry = {
      close: () => onCloseRef.current(),
      isDirty: () => dirtyRef.current,
    };
    modalStack.push(stackEntry);
    // Move focus into the panel on next tick so the modal contents are
    // navigable by keyboard immediately. Fires ONCE on open, not on
    // every render (deps are just [isOpen]).
    queueMicrotask(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const firstFocusable = panel.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? panel).focus();
    });
    return () => {
      const idx = modalStack.lastIndexOf(stackEntry);
      if (idx !== -1) modalStack.splice(idx, 1);
      // Closing by ✕ / Cancel leaves this modal's guard entry on the stack.
      // Drop it, or Back afterwards would be swallowed by a modal that is no
      // longer on screen and appear to do nothing. Flagged as self-inflicted
      // so the handler above does not mistake it for a Back press.
      if (window.history.state?.modalGuard) {
        selfInflictedPops += 1;
        window.history.back();
      }
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  // Mark the modal dirty on the first real edit anywhere inside it.
  // `input` and `change` both bubble, so one pair of listeners on the
  // panel covers every text field, textarea, select, checkbox, radio and
  // file input in the subtree — no per-modal wiring needed.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const markDirty = () => { dirtyRef.current = true; };
    panel.addEventListener('input', markDirty);
    panel.addEventListener('change', markDirty);
    return () => {
      panel.removeEventListener('input', markDirty);
      panel.removeEventListener('change', markDirty);
    };
  }, [isOpen]);

  // Escape already refuses to discard a dirty modal (see the stack handler
  // above), but a RELOAD is outside React's reach and took the same work with
  // it silently. The browser's own prompt is the only thing that can stop it.
  //
  // Guarded on dirtiness, not on being open: a confirm dialog on every reload
  // of an untouched modal would be noise, and noise is how people learn to
  // click through warnings without reading them.
  useEffect(() => {
    if (!isOpen) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isOpen]);

  // Trap Tab inside the panel — wraps around so focus can't leak to the
  // page underneath. Skipped in single-modal cases by browsers anyway,
  // but it matters once two modals stack.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  // Rendered into <body> rather than wherever the modal happens to be declared.
  //
  // Modals are declared next to whatever opens them — the feedback modal lives
  // in TopBar, which sits BEFORE <main> in the DOM. A `position: sticky` table
  // header inside <main> then painted ON TOP of the open modal: the dark
  // backdrop covered the page, but a bright strip of column headings sat across
  // the dialog, and it was clickable through it (elementFromPoint returned the
  // TH, not the backdrop). Reported from the Inventory Audit Trail, where the
  // events table has a sticky header.
  //
  // z-index was NOT the lever — measured live, the modal at z-index 9999 still
  // lost to a sticky header at z-index 10, while moving the same node to the
  // end of <body> fixed it at the original z-index 50. So the fix is DOM
  // position, and a portal is what makes that true no matter where a modal is
  // declared. It also fixes every other modal at once instead of chasing
  // individual sticky elements down.
  //
  // React portals keep context and event bubbling on the React tree, so
  // providers (toast, confirm, auth) and onChange handlers behave exactly as
  // before — only the DOM parent changes.
  return createPortal(
    <div className="fixed inset-0 overflow-y-auto" style={{ zIndex: 50 + depth * 10 }} aria-labelledby="modal-title" role="dialog" aria-modal="true">
      <div className="flex items-center justify-center min-h-screen p-4">

        {/* Backdrop — deliberately NOT clickable to dismiss.
            These modals are long forms (raise an indent, a component request, a
            BOM slip), and a stray click on the dark area used to throw the
            whole half-filled form away with no undo and no warning. Closing is
            now an explicit act: the ✕ in the header or a Cancel/Close button.
            Escape also closes, but only while the form is still untouched.
            If a modal ever genuinely wants click-outside-to-dismiss,
            that should be an opt-in prop, not the default for all 90-odd. */}
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm fade-in" />

        {/* Panel */}
        <div
          ref={panelRef}
          tabIndex={-1}
          className={`relative bg-card rounded-2xl shadow-lg w-full ${SIZE_MAX_W[size]} mx-auto p-5 md:p-6 z-10 outline-none modal-in`}
        >
          <div className="flex items-center justify-between mb-4 gap-3">
            <h3 className="text-base font-bold text-ink min-w-0 truncate" id="modal-title">{title}</h3>
            <div className="flex items-center gap-2 shrink-0">
              {headerRight}
              {/* Named because this is the control every modal focuses on open —
                  a screen reader announced the dialog and then just "button". */}
              <button onClick={onClose} aria-label="Close dialog" className="p-1 rounded-md text-faint hover:text-secondary hover:bg-hover transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
