# Contrast audit — 2026-09-23, after the fixes

**0 failing text nodes.** 18 routes x 2 themes = 36 screen-visits, WCAG AA
(4.5:1 normal, 3:1 for >=24px or >=18.66px bold). Previous run: 152.

## Correction to the previous run's numbers

That audit reported 193 dark-mode call sites failing. It was wrong. It resolved
backgrounds by walking computed `background-color` and ignored
`background-image` — and `.bg-brand.text-white` is painted by `--brand-gradient`,
which covers the colour entirely. Pixels measured off the PNGs:

    "Raise Indent"      rgb(130,56,236)  gradient  5.64:1  never broken
    sidebar active pill rgb(140,53,235)  gradient  5.49:1  never broken
    "New note"          rgb(192,132,252) flat      2.64:1  genuinely broken

The real fault was 29 controls, not 193: the ones written `bg-brand text-ink`,
which the gradient rule never matches, leaving the raw token as the fill. Those
failed in BOTH themes (light 3.11:1, dark 2.13:1) — not a dark-mode bug.

Cause was the reskin's own hex sweep: it mapped #2D2D2D -> `ink` and
#D4AA7B -> `brand`, and dark text that was correct on tan is wrong on violet.

The audit now resolves gradient stops and scores against the worst one.

## Fixed

1. 29 `bg-brand text-ink` -> `text-white`, so the gradient rule covers them.
   Measured: "New note" dark 2.64 -> 5.47:1, light 5.70 -> 5.47:1.

2. CSS safety net — `.dark .bg-brand:not(.text-white)` falls back to
   `--c-brand-fill`, which does not invert. The next control that forgets
   `text-white` stays legible instead of silently failing.

3. Text ramp, light: secondary/muted/faint stepped down to gray-800/700/600.
   The binding case is bg-hover (#f3f4f6) — a hovered table row — where even
   gray-500 reaches only 4.39:1. Ramp is more compressed than the guide's;
   legibility won.

4. Text ramp, dark: muted -> #b0b7c4, faint -> #949dac. The old dark faint was
   tuned against the card and zebra row and hit 3.96:1 on a hovered row.

5. 244 semantic text colours -> the -700 shades (red/amber/green/emerald).
   Includes utils/stock.ts, a `.ts` file the first sweep missed because it
   globbed `*.tsx` only — one helper that colours every stock figure in the app,
   so a single line accounted for a large share of the remaining failures.

6. 24 emerald button fills 600 -> 700 (white label 3.77 -> 5.48:1).

`dark:` variants were left alone throughout; they already passed.
