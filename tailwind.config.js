/** @type {import('tailwindcss').Config} */

/**
 * ONE source of truth for the palette.
 *
 * The app used to carry its colours as ~3,600 hardcoded Tailwind arbitrary
 * values (`text-[#2D2D2D]`, `bg-[#D4AA7B]`, …) spread over 152 files, so a
 * reskin meant a find-and-replace across the whole tree and any missed spot
 * left a stale colour behind. Those are named tokens now.
 *
 * Every token below is `rgb(var(--channel) / <alpha-value>)` rather than a
 * hex. Tailwind substitutes the alpha, which is what keeps opacity modifiers
 * working — `bg-brand/10` compiles to `rgb(var(--c-brand) / 0.1)`. Handing
 * Tailwind a hex through a variable instead would silently break every `/10`
 * in the codebase, because `#7c3aed / 0.1` is not a colour.
 *
 * The channels themselves live in src/index.css, where `.dark` swaps the whole
 * set. That is the entire dark-mode mechanism: nothing in this file, and
 * nothing in any component, differs between themes.
 *
 * Roles, not hues — the names say what a colour is FOR, which is why they
 * survived both the tan -> violet reskin and the light -> dark work without
 * being renamed.
 */
export default {
  // `.dark` on <html> is the switch (see hooks/useTheme). Tailwind's default,
  // 'media', would bind the theme to the OS with no way to override it in-app.
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* brand-50/100  soft tile + wash backgrounds
         * brand-200     hairline borders on branded surfaces
         * brand-light   light accent / gradient tail
         * brand         PRIMARY — buttons, active nav, focus, links
         * brand-600     alt primary
         * brand-dark    hover / deeper than brand
         * brand-700     saturated text+icon on a brand-100 tile
         *
         * `brand` does double duty as the fill under `bg-brand` and the colour
         * of `text-brand`, which want opposite things on a dark ground. It
         * works out because a primary action is `bg-brand text-white`, and
         * that pair is painted by --brand-gradient (a background-image, which
         * covers the background-colour). So the token only ever shows on text,
         * borders, rings and low-opacity tints — all of which want the lighter
         * value in dark mode.
         */
        brand: {
          50:      'rgb(var(--c-brand-50) / <alpha-value>)',
          100:     'rgb(var(--c-brand-100) / <alpha-value>)',
          200:     'rgb(var(--c-brand-200) / <alpha-value>)',
          light:   'rgb(var(--c-brand-light) / <alpha-value>)',
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          600:     'rgb(var(--c-brand-600) / <alpha-value>)',
          dark:    'rgb(var(--c-brand-dark) / <alpha-value>)',
          700:     'rgb(var(--c-brand-700) / <alpha-value>)',
          fill:    'rgb(var(--c-brand-fill) / <alpha-value>)',
          'fill-hover': 'rgb(var(--c-brand-fill-hover) / <alpha-value>)',
        },

        // Surfaces. `card` is what ~260 hardcoded `bg-white`s became: a real
        // token, so the card can go navy in dark mode instead of staying white.
        page:     'rgb(var(--c-page) / <alpha-value>)',
        card:     'rgb(var(--c-card) / <alpha-value>)',
        surface:  'rgb(var(--c-surface) / <alpha-value>)',
        hover:    'rgb(var(--c-hover) / <alpha-value>)',
        zebra:    'rgb(var(--c-zebra) / <alpha-value>)',
        expanded: 'rgb(var(--c-expanded) / <alpha-value>)',

        // `line` is the standard hairline; `line-soft` the fainter one used
        // between table rows.
        line: {
          DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
          soft:    'rgb(var(--c-line-soft) / <alpha-value>)',
        },

        // Text ramp, strongest to weakest.
        ink:       'rgb(var(--c-ink) / <alpha-value>)',
        secondary: 'rgb(var(--c-secondary) / <alpha-value>)',
        muted:     'rgb(var(--c-muted) / <alpha-value>)',
        faint:     'rgb(var(--c-faint) / <alpha-value>)',

        // The dark rounded square behind the favicon / app-icon glyphs. Fixed
        // in both themes — a browser tab has no theme of ours.
        mark: '#1a1a2e',
      },
      fontFamily: {
        sans: ['Poppins', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
