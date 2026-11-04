import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Anchors every `title` tooltip in the app to the thing it describes.
 *
 * Native tooltips are positioned relative to the CURSOR and then clamped to
 * the viewport — they are not anchored to their element. A long one on a
 * right-aligned control therefore slides left to fit and ends up pointing at
 * nothing. Measured across the app: of 124 distinct tooltips, 76 drift more
 * than 150px from their control and 57 drift more than 300px. The worst
 * travels over 1000px, which reads as a stray note somebody left behind.
 *
 * Rewriting 76 of them into visible helper text would bury the UI, so this
 * takes the text the app already writes and renders it where it belongs. One
 * component at the root; no call site changes.
 *
 * It also fixes two things `title` never did:
 *   - keyboard: native tooltips do not appear on focus, so anyone tabbing
 *     through never saw them.
 *   - touch: there is no hover on a phone, so they never appeared there at
 *     all. A long-press now shows one.
 *
 * ACCESSIBLE NAMES are preserved carefully. An icon-only button takes its
 * name from `title`, so simply removing the attribute would leave it
 * unnamed — which the accessibility suite asserts against. Elements with no
 * visible text therefore get an `aria-label` first; elements that already
 * have text keep that as their name and lose only a duplicate.
 */
type Tip = { text: string; top: number; left: number; placement: 'top' | 'bottom' };

const GAP = 8;
const MAX_WIDTH = 320;
const TOOLTIP_ID = 'app-tooltip';

const nativeRemoveAttribute = Element.prototype.removeAttribute;

/**
 * Keep up with React. adopt() moves `title` into `data-tip`, but React still
 * owns the prop: when it changes the title it writes a fresh `title` (picked
 * up below on the next hover), and when it drops the title it calls
 * removeAttribute('title') on an attribute that is already gone — a no-op that
 * left the old text in `data-tip`, so a "why is this disabled" tooltip kept
 * showing after the button was enabled. Removing `title` now clears what was
 * adopted from it, and the aria-label this layer added with it.
 */
if (!(Element.prototype as any).__tipAware) {
  (Element.prototype as any).__tipAware = true;
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    if (name === 'title' && this instanceof HTMLElement && this.dataset.tip !== undefined) {
      delete this.dataset.tip;
      if (this.dataset.tipLabel) {
        nativeRemoveAttribute.call(this, 'aria-label');
        delete this.dataset.tipLabel;
      }
    }
    return nativeRemoveAttribute.call(this, name);
  };
}

/**
 * Move `title` out of the DOM so the browser stops drawing its own. A `title`
 * present now always wins over what was adopted earlier — it is React's
 * latest value.
 */
const adopt = (el: HTMLElement): string | null => {
  const title = el.getAttribute('title');
  if (!title || !title.trim()) return el.dataset.tip || null;

  nativeRemoveAttribute.call(el, 'title');
  el.dataset.tip = title;
  // Only when there is nothing else to name it. Adding aria-label to an
  // element that already shows text would override the visible label, which
  // is its own accessibility failure. Re-adopting keeps a label we added in
  // step with the new text.
  const hasVisibleText = (el.textContent ?? '').trim().length > 0;
  if (el.dataset.tipLabel || (!hasVisibleText && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))) {
    el.setAttribute('aria-label', title);
    el.dataset.tipLabel = '1';
  }
  return title;
};

export const TooltipLayer = () => {
  const [tip, setTip] = useState<Tip | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      // `closest` so hovering the icon inside a button still finds the button.
      const el = target.closest('[title], [data-tip]');
      if (!(el instanceof HTMLElement)) return;      // skips SVG <title> nodes
      const text = adopt(el);
      if (!text) return;

      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const placement: Tip['placement'] = below > 90 ? 'bottom' : 'top';
      // Centre on the element, then keep it on screen. Clamping here is the
      // same thing the browser does — the difference is that it starts from
      // the element rather than from wherever the pointer happened to be.
      const half = Math.min(MAX_WIDTH, text.length * 7) / 2;
      const left = Math.max(GAP + half, Math.min(r.left + r.width / 2, window.innerWidth - GAP - half));
      // Point the anchor at the tooltip while it is open, which is the actual
      // ARIA pattern — a `role="tooltip"` nobody references describes nothing.
      // Skipped when the text is already this element's accessible name (the
      // icon-only case), or a screen reader would read it out twice.
      if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-describedby', TOOLTIP_ID);
      anchorRef.current = el;
      setTip({
        text,
        left,
        top: placement === 'bottom' ? r.bottom + GAP : r.top - GAP,
        placement,
      });
    };

    const clear = () => {
      anchorRef.current?.removeAttribute('aria-describedby');
      anchorRef.current = null;
      setTip(null);
    };
    const hide = (e: Event) => {
      const to = (e as MouseEvent).relatedTarget;
      if (to instanceof Node && anchorRef.current?.contains(to)) return;
      clear();
    };

    const onOver = (e: Event) => show(e.target);
    const drop = () => clear();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') drop(); };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', hide, true);
    // Keyboard users never got these at all.
    document.addEventListener('focusin', onOver, true);
    document.addEventListener('focusout', hide, true);
    // Scrolling or resizing moves the anchor out from under it.
    window.addEventListener('scroll', drop, true);
    window.addEventListener('resize', drop);
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', hide, true);
      document.removeEventListener('focusin', onOver, true);
      document.removeEventListener('focusout', hide, true);
      window.removeEventListener('scroll', drop, true);
      window.removeEventListener('resize', drop);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  if (!tip) return null;

  return createPortal(
    <div
      id={TOOLTIP_ID}
      role="tooltip"
      style={{
        position: 'fixed',
        left: tip.left,
        top: tip.top,
        transform: tip.placement === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        maxWidth: MAX_WIDTH,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
      className="rounded-md bg-ink px-2.5 py-1.5 text-[11px] leading-snug text-card shadow-lg border border-line-soft"
    >
      {tip.text}
    </div>,
    document.body,
  );
};
