# Contrast audit — 2026-09-23

Measured from the live DOM (computed colour vs nearest opaque ancestor
background), 8 screens per theme, WCAG AA thresholds: 4.5:1 normal text,
3:1 for >=24px or >=18.66px bold.

**152 failing text nodes: 129 light, 23 dark.** Two systemic causes.

## 1. Light mode — `text-faint` is gray-400 on white (129 nodes)

    rgb(156,163,175) on rgb(255,255,255)  = 2.54:1   (need 4.5)
    rgb(156,163,175) on rgb(250,250,250)  = 2.43:1   (need 4.5)

Affects timestamps ("50m ago"), counts ("3 admins · 1 managers · 19 users"),
empty states ("No indents currently awaiting payment."), italic placeholders
("Not quoted yet", "General / Others").

This one is INHERITED, not introduced: #9CA3AF was the original palette's
"faint" and the reskin tokenised it faithfully. It has been flagged before and
not acted on, because the fix is not free — the only value that reaches 4.5:1
on white is around gray-500, which is what `--c-muted` already is. Enforcing AA
here collapses four text tiers into three.

## 2. Dark mode — brand fills carry white text (17 of the 23)

    rgb(255,255,255) on rgb(192,132,252)  = 2.64:1   (need 4.5)

Hits the active sidebar item, the Feedback pill, "Raise Indent", "Quote", and
every other filled brand control — 193 call sites combine `bg-brand` with
`text-white` or `text-ink`.

This one IS introduced by the reskin. `--c-brand` flips to purple-400 in dark so
that `text-brand` stays legible ON a dark background; the same token also fills
buttons, where the requirement is the opposite. One token, two incompatible
jobs.

    light  violet-600 fill + white text = 5.70:1  PASS
    dark   purple-400 fill + white text = 2.64:1  FAIL

Fix without changing light mode: give fills their own token (`--c-brand-fill`)
that does NOT lighten in dark, and point the 193 filled controls at it.

## 3. One-off

    "Send to Finance →"  white on emerald-600  = 3.77:1  (need 4.5)

## Correction to an earlier claim

The reskin was reported as landing dark mode with "0 contrast failures". That
was wrong. The audit behind it compared text colours against page and card
backgrounds only, and never against brand-filled controls, so the entire class
of failure above was outside what was measured.
