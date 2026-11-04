# Contrast — 2026-09-24 06:21

**0 failing text nodes.** 97 screens x 2 themes, plus 0 runtime problems.

## Why the previous run said 0 and this one found 22

Neither group was a regression. Both were pre-existing bugs that only became
visible when data reached the branches that render them:

- The **Server Snapshot row** (4 failures, worst 1.02:1) exists only because a
  JSON backup was uploaded and restored at 10:13 on 23 Sept. The clean run was
  at 09:45 — the row did not exist yet.
- The **buttons** (18 failures: "Remind Admin", "Issue", "Review quote") render
  only for indents and requests in particular states. The V1 restore brought 58
  indents and more requests, reaching branches the earlier snapshot never did.

So the earlier zero was not wrong, it was INCOMPLETE. A walkthrough audits what
renders, and the data decides what renders. A green sweep is evidence about the
paths it walked, not proof of absence.

## What was wrong

    bg-orange-500 + white text   x8   2.80:1
    bg-green-600  + white text   x6   3.30:1
    bg-amber-600  + white text   x2   3.19:1
    bg-amber-500  + white text   x2   2.15:1
    snapshot row, dark mode      x4   1.02 - 1.60:1

The earlier accessibility pass darkened `text-*` utilities and `bg-emerald-600`,
and never touched the other coloured FILLS. 29 buttons moved to the -700 shades:

    white on amber-700   5.02:1
    white on orange-700  5.18:1
    white on green-700   5.02:1

The snapshot row was `bg-amber-50/70` with no dark variant — a light wash that
stays light in dark mode, leaving light text on a pale beige band. Same class as
the Off-site Backup banner fixed earlier, and it escaped the same sweep for the
same reason: the `/70` opacity suffix fell outside the regex. Swept app-wide for
that shape; this was the only instance.
