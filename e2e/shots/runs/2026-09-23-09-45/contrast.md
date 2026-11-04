# Contrast — 2026-09-23 09:45

**0 failing text nodes.** Every screen (97 x 2 themes), not a hand-picked list.

## How the earlier numbers were wrong

The first full-app sweep reported 97. Checked one by one against real pixels,
88 were the AUDIT and 9 were the app.

    54  disabled pagination buttons — WCAG 1.4.3 exempts inactive controls
    32  Messages empty state scored against rgb(0,0,0), because bgOf gave up
         walking and fell back to black instead of the theme's page colour
    16  Messages empty state scored against the DOT colour of a 1px-on-24px
         radial pattern — a pattern covering ~0.3% of the area is not a
         background (this replaced the 32 after the first fix)
     2  the Off-site Backup banner scored against opaque blue-400, because the
         gradient parser dropped the /10 alpha

All four are fixed in walkthrough.capture.ts: alpha-aware gradient stops,
translucent layers composited on the walk, page-colour fallback, disabled
elements exempt, sparse patterns ignored.

An earlier version of this same audit also claimed 193 dark-mode failures by
reading background-COLOR while the element was painted by a background-IMAGE.
That is five distinct measurement bugs. The instrument has been wrong more
often than the code it measures, which is the reason every finding here was
confirmed against pixels before anything was changed.

## The 9 real ones

1. Off-site Backup banner: `from-blue-50/50 to-indigo-50/40` with no dark
   variant — a light wash under near-white text at 1.11:1. One line in the
   whole app. Fixed with dark stops.

2. 17 labels reading white on a PALE tint (worst 1.16:1). Self-inflicted: the
   earlier `text-ink -> text-white` sweep triggered on `bg-brand`, and
   `bg-brand/10` matched too because `/` is not a word character. White now
   goes only on a SOLID bg-brand fill.

3. `opacity-70` on a SummaryTile sub-label: 2.89-3.63:1. The tile's accent
   already passes at full strength; the opacity was the whole problem.

4. `bg-brand/20 text-brand` chips at 4.05-4.22:1 -> `text-brand-700`, 5.06-5.26.

5. Messages dot texture hardcoded `#f3f4f6`, so dark mode rendered bright
   speckle rather than subtle texture. Now `rgb(var(--c-line))`.

## Theme toggle: not an app defect

74 screens were toggled into a theme and compared against a fresh load of that
theme. All 74 rendered identically, so no screen requires a reload. Consistent
with the code: only TopBar consumes useTheme, and there is no getComputedStyle,
no cached theme read, no chart library and no hardcoded fill anywhere.

A user-reported "have to refresh on SOME pages" therefore points below the app,
most likely GPU compositing of the 9 backdrop-blur layers. Headless Chromium
composites in software, so that class of bug cannot reproduce here by
construction — worth stating rather than concluding "works fine".
