interface BrandLoaderProps {
  /**
   * `inline` for a panel or table body, `page` for a full-height takeover
   * (route chunk streaming in, first paint after sign-in).
   */
  variant?: 'inline' | 'page';
  /** Shown under the loader in the `page` variant. */
  message?: string;
  /** Overrides the accessible name. Defaults to `message`, else "Loading". */
  label?: string;
}

/**
 * The app-wide loading indicator: a ball hopping up a staircase of bars.
 *
 * All the geometry — bar widths, the ascending heights, the travel distance,
 * the landing and apex positions — lives in index.css (.loader-rig and the
 * loader-x / loader-y keyframes). This component deliberately holds no
 * numbers: an earlier version split them across both files and they drifted.
 *
 * The bars are FIXED. Only the ball moves, landing on each bar top in turn.
 * The horizontal and vertical animations sit on two nested elements but share
 * one 4s period, which is what keeps the ball on the bars rather than
 * bouncing wherever it happens to be.
 *
 * Motion is CSS, so the global prefers-reduced-motion rule flattens it to a
 * static staircase with the ball resting on the first bar — still a legible
 * "busy" state, just still.
 *
 * The whole thing is one `role="status"` with an accessible name, and the
 * bars are aria-hidden: a screen reader hears "Loading…" once instead of
 * being read six decorative spans.
 */
export const BrandLoader = ({ variant = 'inline', message, label }: BrandLoaderProps) => {
  const accessibleName = label ?? message ?? 'Loading';

  const loader = (
    <div className="flex flex-col items-center gap-4">
      {/* pt-6 reserves the headroom the ball needs at the top of its arc, so
          the surrounding layout doesn't shift as it hops. */}
      <div className="pt-6" aria-hidden="true">
        <div className="loader-rig">
          <span className="loader-bar bg-brand/25" />
          <span className="loader-bar bg-brand/25" />
          <span className="loader-bar bg-brand/25" />
          <span className="loader-bar bg-brand/25" />
          <span className="loader-bar bg-brand/25" />
          {/* Outer span traverses, inner span hops. Must stay the last child —
              the bar heights are addressed by :nth-child. */}
          <span className="loader-x">
            <span
              className="loader-y"
              style={{ background: '#964beb', boxShadow: '0 0 12px rgba(150, 75, 235, 0.7)' }}
            />
          </span>
        </div>
      </div>

      {variant === 'page' && message && (
        <p className="text-sm font-semibold text-brand">{message}</p>
      )}
    </div>
  );

  if (variant === 'page') {
    return (
      <div
        role="status"
        aria-label={accessibleName}
        className="flex min-h-[60vh] w-full items-center justify-center"
      >
        {loader}
      </div>
    );
  }

  return (
    <div role="status" aria-label={accessibleName} className="flex justify-center py-10">
      {loader}
    </div>
  );
};
