# FUT Squad Lab — component specification

Implementation contract for the injected panel, the toolbar popup and the options page.
Every value here is a `--fsl-*` token or a fixed pixel value from `tokens.css`. Nothing in
this document introduces a colour, radius, duration or size that is not already a token —
if you need a new one, add it to `tokens.css` first.

Components are addressed by class. Behaviour is driven by `data-*` attributes on the
element that owns the state, so a single row markup serves every card state, every lock
state and both panel widths.

---

## 1. Shell

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Injection root | `.fsl-root` | `data-theme="dark" \| "light"` (dark default; light is a second token block) | `background: var(--fsl-surface-0)`, `border: 1px solid var(--fsl-border)`, `border-radius: var(--fsl-r-3)`, `box-shadow: var(--fsl-shadow-panel)`, `font: 400 var(--fsl-fs-13)/var(--fsl-lh-base) var(--fsl-font-ui)` |
| Panel width | `.fsl-root` | `--fsl-panel-w` set by the width control | `clamp(var(--fsl-panel-min), var(--fsl-panel-w), var(--fsl-panel-max))`; steps 320 / 360 / 400 / 420 |
| Fixed column | `.fsl-root` | docked side column | `width: 100%; max-width: var(--fsl-panel-max); max-height: 100dvh; display: flex; flex-direction: column;` |

The root never reads a host custom property and never styles a host selector. The panel
must remain correct if the host stylesheet is replaced between game versions.

---

## 2. Panel header

```
┌ .fsl-head ──────────────────────────────────────────┐
│ SBC — 3 LEAGUES & 2 NATIONS          [UNOFFICIAL]   │  .fsl-head-top
│ Rewards · Advanced · 4-3-3                          │  .fsl-head-sub
├ .fsl-costbar ───────────────────────────────────────┤
│ FODDER COST │ FROM CLUB │ TO BUY │ CHEM │ AVG       │
│ 18,400      │ 8         │ 3      │ 22   │ 81        │
└─────────────────────────────────────────────────────┘
```

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Header block | `.fsl-head` | — | `background: var(--fsl-surface-1)`, `border-bottom: 1px solid var(--fsl-border)`, `padding: var(--fsl-sp-6)` |
| Challenge name | `.fsl-head-title` | truncates at 2 lines | `font-size: var(--fsl-fs-15)`, `font-weight: var(--fsl-w-semibold)`, `text-transform: uppercase`, `letter-spacing: var(--fsl-track-wide)`, `line-height: var(--fsl-lh-tight)` |
| Badge | `.fsl-badge` | "unofficial · MIT" | `font: 400 var(--fsl-fs-10)/1 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-caps)`, `color: var(--fsl-fg-dim)`, `border: 1px solid var(--fsl-border)`, `border-radius: var(--fsl-r-1)`, `padding: 3px 5px` |
| Set / formation line | `.fsl-head-sub` | — | `font: var(--fsl-fs-11)/var(--fsl-lh-snug) var(--fsl-font-mono)`, `color: var(--fsl-fg-muted)`, `text-transform: uppercase` |
| Cost bar | `.fsl-costbar` | column of two rows | `background: var(--fsl-surface-inset)`, `border-top: 1px solid var(--fsl-border)`, `padding: var(--fsl-sp-4) var(--fsl-sp-5)`, `gap: var(--fsl-sp-4)` |
| Headline row | `.fsl-costbar-main` | exactly two cells: fodder cost, to buy | `grid-template-columns: repeat(2, minmax(0, 1fr))`, `gap: var(--fsl-sp-5)`. Two columns at every width — a three-column grid wraps five cells and leaves a hole |
| Secondary row | `.fsl-costbar-sub` | from club, chem, avg — label/value pairs | `display: flex; flex-wrap: wrap; gap: 3px var(--fsl-sp-6)`; each `.fsl-cell` is `display: flex; align-items: baseline; gap: 5px`, value at `var(--fsl-fs-12)` |
| Cost cell label | `.fsl-costbar dt` | — | `font: 400 var(--fsl-fs-10)/1 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-caps)`, `text-transform: uppercase`, `color: var(--fsl-fg-dim)` |
| Cost cell value | `.fsl-costbar dd` | `.fsl-num` | `font-size: var(--fsl-fs-15)`, `font-weight: var(--fsl-w-medium)`, `color: var(--fsl-fg)`; the headline value (`totalCost`) is `var(--fsl-fs-20)` |
| Cost delta | `.fsl-costbar dd[data-delta="down"]` | after a swap | `color: var(--fsl-success)`; `data-delta="up"` → `var(--fsl-warning)`. Text is always signed (`−1,200`) — colour is the secondary cue |
| `to buy` cell | `.fsl-cell[data-warn="true"]` | when purchases are required | value `color: var(--fsl-warning)`; the count and the coin total share one value (`3 · 11.500`) |

The cost bar is `aria-live="polite"` and is announced as one string
(`a11y.costTotal`), never as five separate numbers.

---

## 3. Toolbar

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Toolbar | `.fsl-toolbar` | — | `display: flex; justify-content: space-between; align-items: center`, `padding: var(--fsl-sp-4) var(--fsl-sp-5)`, `border-bottom: 1px solid var(--fsl-border)` |
| Slot counter | `.fsl-toolbar-count` | `data-full="true"` | `font: var(--fsl-fs-11) var(--fsl-font-mono)`, `color: var(--fsl-fg-muted)`; when `data-full="true"` → `color: var(--fsl-fg)` |
| Primary action | `.fsl-btn-primary` | `solve` / `solve again` / `solving` (disabled) | `background: var(--fsl-accent)`, `color: var(--fsl-accent-fg)`, `border-radius: var(--fsl-r-2)`, `height: var(--fsl-ctl)`, `padding: 0 var(--fsl-sp-5)`, `font-size: var(--fsl-fs-12)`, `font-weight: var(--fsl-w-semibold)` |
| ↑ hover | same | `:hover` | `background: color-mix(in oklch, var(--fsl-accent) 88%, black)` — L moves −0.07, text unchanged |
| ↑ focus | same | `:focus-visible` | `outline: 2px solid var(--fsl-accent); outline-offset: 2px` |
| ↑ active | same | `:active` | `transform: translateY(1px)` |
| ↑ disabled (solving) | same | `[disabled]` | `opacity: .55; cursor: default` — the only state allowed to reduce contrast |
| Ghost action | `.fsl-btn-ghost` | copy list, retry, rescan | `background: transparent; border: 1px solid var(--fsl-border-strong); color: var(--fsl-fg-muted)`; hover → `border-color: var(--fsl-fg); color: var(--fsl-fg)` |

**One primary button per viewport.** Solve, solve-again and the buy-required action are the
same action in different states, so exactly one primary button exists at any time. Idle,
solving and solved states must not render two. The toolbar stays mounted while the solver
runs and its primary button is `[disabled]` with the label `panel.solvingLabel` — the panel
never swaps a live control out for nothing, and the cost bar keeps its last values visible.

**Where the primary lives.** In `solved` and `solving` it sits in the toolbar; in `idle` it is
the full-width button at the foot of the idle view (the toolbar is not rendered, so it cannot
double up). `noSolution` renders no primary at all — its three ways forward are secondary.

---

## 4. Slot row — the core component

```
┌ .fsl-row ───────────────────────────────────────────────────────────────┐
│ CAM  ⬤NAT │ Player 04              │ 84  L31 A07 C12 │ ⇄ TRADEABLE│1,200│ 📌 │
│           │ 84 OVR · L31 · A07     │                 │            │     │    │
└─────────────────────────────────────────────────────────────────────────┘
  .fsl-pos   .fsl-ident              .fsl-meta          .fsl-chip   .fsl-cost .fsl-lock
```

Grid: `grid-template-columns: 44px minmax(0, 1fr) auto 32px`, `align-items: center`.
Row height is fixed at two lines for **every** row — the chip sits at the right edge of the
identity's first line, not in a column of its own, because the longest state word
("Kan ikke sælges", 15 characters at 10 px mono ≈ 126 px) would otherwise starve the code
line below it and make row heights depend on the label. Row height: 46 px at every width.

Width budget, verified by `tools/vision-smoke-test.js` (mono 10 px ≈ 6.2 px/char,
UI 13 px ≈ 7.0 px/char):

| Panel width | Fixed columns | Identity column | Worst row uses |
|---|---|---|---|
| 400 px | 44 + 48 + 32 + 3×6 = 145 | 229 px | ≤ 81 % |
| 320 px | 38 + 42 + 32 + 3×5 = 127 | 175 px | ≤ 79 % |

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Row | `.fsl-row` | `data-state="tradeable\|untradeable\|duplicate\|concept"`, `data-locked="true"`, `data-fit="nat\|oop"`, `data-open="true"`, `data-swapped="true"` | `min-height: var(--fsl-row-min-h)` (46 px, two lines), `padding: var(--fsl-sp-4) var(--fsl-sp-5)`, `background: var(--fsl-surface-1)`, `border-bottom: 1px solid var(--fsl-border)` |
| ↑ hover | `.fsl-row:hover` | — | `background: var(--fsl-surface-2)` (L +0.047, `var(--fsl-dur-1)`) |
| ↑ open (alternatives visible) | `[data-open="true"]` | — | `background: var(--fsl-surface-2)`, `border-bottom-color: transparent` |
| ↑ locked | `[data-locked="true"]` | — | `background: var(--fsl-surface-2)`, `box-shadow: inset 0 0 0 1px var(--fsl-border-inverse)`; name gets `font-weight: var(--fsl-w-medium)`. Calm, neutral, never warning-coloured |
| ↑ swapped (confirmation) | `[data-swapped="true"]` | 340 ms | `background: color-mix(in oklch, var(--fsl-surface-2) 70%, var(--fsl-accent) 30%)`, `animation: fsl-swap var(--fsl-dur-4) var(--fsl-ease-settle)` |
| ↑ focus | `.fsl-row:focus-visible` | keyboard | `outline: 2px solid var(--fsl-accent); outline-offset: -2px` (inside, so the ring cannot clip in a 320 px column) |
| Slot code | `.fsl-pos` | natural / out of position | `font: var(--fsl-w-semibold) var(--fsl-fs-11)/1.2 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-caps)`, `color: var(--fsl-fg)`; `[data-fit="oop"]` → `color: var(--fsl-warning)` + a `↔` glyph, so the state survives greyscale. The fit word under the code is `fit.naturalShort` / `fit.outOfPositionShort` (`NAT` / `OOP`), and the full words live in `aria-label` |
| Identity line 1 | `.fsl-ident-top` | name + chip | `display: flex; align-items: center; justify-content: space-between; gap: var(--fsl-sp-6)` — the chips therefore line up in a vertical column down the list, which is what makes the states scannable |
| Player name | `.fsl-ident-name` | — | `font-size: var(--fsl-fs-13)`, `font-weight: var(--fsl-w-medium)`, `color: var(--fsl-fg)`, `text-wrap: balance` |
| Meta line | `.fsl-meta` | rating · league · nation · club | `font: var(--fsl-fs-10)/var(--fsl-lh-snug) var(--fsl-font-mono)`, `font-variant-numeric: tabular-nums`, `color: var(--fsl-fg-dim)`, `letter-spacing: 0.02em`, `white-space: nowrap` at ≥360 px, wrapping at 320 px |
| Cost cell | `.fsl-cost` | club card (`0`) vs concept (quoted price) | `font: var(--fsl-fs-13) var(--fsl-font-mono)`, tabular, `text-align: right`, `min-width: 56px`; club cards read `0` in `var(--fsl-fg-dim)`, concepts read the price in `var(--fsl-fg)` |
| Lock button | `.fsl-lock` | `aria-pressed`, `data-locked` | `width/height: var(--fsl-ctl)`, `border-radius: var(--fsl-r-1)`, icon 14 px; hit area extended to `var(--fsl-hit)` with `::after { inset: -6px }`. Hover → `background: var(--fsl-surface-2)` + `color: var(--fsl-fg)`. Focus → same ring as the row. Locked → icon `var(--fsl-fg)` filled, `data-locked="false"` icon is an outline in `var(--fsl-fg-dim)` |

### Card-state chip

Each state is colour **+ glyph + word**. Remove colour entirely and the three cues still
separate the states.

| State | Token | Glyph | Label key | Chip |
|---|---|---|---|---|
| tradeable | `--fsl-state-tradeable` (`--fsl-fg-muted`) | `⇄` | `cardState.tradeable` | `background: var(--fsl-state-tradeable-bg)`, `border: 1px solid var(--fsl-border-strong)` |
| untradeable | `--fsl-state-untradeable` (`--fsl-success`) | `⛓̶` (broken link) | `cardState.untradeable` | `background: var(--fsl-state-untradeable-bg)` |
| duplicate | `--fsl-state-duplicate` (`--fsl-warning`) | `⧉` | `cardState.duplicate` | `background: var(--fsl-state-duplicate-bg)` |
| concept | `--fsl-state-concept` (`--fsl-accent`) | `+` | `cardState.concept` | `background: var(--fsl-state-concept-bg)`, `border: 1px dashed var(--fsl-accent-line)` |

Chip metrics: `font: 500 var(--fsl-fs-10)/1 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-wide)`,
`text-transform: uppercase`, `padding: 4px 6px`, `border-radius: var(--fsl-r-1)`, `gap: 4px`,
`pointer-events: none` so a click anywhere in the row still reaches the row's toggle.

**Below 348 px of panel width** the word is dropped and the chip renders as its glyph alone
(`padding: 5px`). The state is still carried by three non-colour channels — glyph shape, the
`title` tooltip and the chip's `aria-label` ("Kan ikke sælges — bliver i klubben") — and row
heights stay even. Above 348 px the word is always visible.

Contrast: every chip colour clears 4.5:1 on its own 16 % tint (measured 7.5 / 7.9 / 7.5 / 5.1:1).

---

## 5. Alternatives panel

Rendered inline directly beneath its row (`data-open="true"`), never as a floating card:
at 320 px a popover would have to overlay the row it belongs to.

```
┌ .fsl-alts ──────────────────────────────────────────────────────────────┐
│ ALTERNATIVER TIL CAM          Rangeret efter fyldpris                  │
│ 1  Player 09   84 CAM  1,200   Samme liga · 1 rating lavere   [Skift ind]│
│ 2  Player 13   83 CM     900   Samme nation · bryder 1 link   [Skift ind]│
│ 3  Player 21   85 CAM   2,400   Beholder keminiveauet         [Skift ind]│
│                                    {count} flere i puljen →             │
└─────────────────────────────────────────────────────────────────────────┘
```

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Container | `.fsl-alts` | expands under the row | `background: var(--fsl-surface-inset)`, `padding: var(--fsl-sp-4) var(--fsl-sp-5) var(--fsl-sp-5)`, `border-bottom: 1px solid var(--fsl-border)`, `animation: fsl-open var(--fsl-dur-2) var(--fsl-ease-out)` (height 0 → auto via `grid-template-rows: 0fr → 1fr`, plus opacity 0 → 1) |
| Title | `.fsl-alts-title` | `alts.title` | `font: var(--fsl-w-semibold) var(--fsl-fs-10)/1 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-caps)`, `text-transform: uppercase`, `color: var(--fsl-fg-dim)` |
| Alt row | `.fsl-alt` | `data-rank`, `data-current="true"` | `grid-template-columns: 16px minmax(0,1fr) 56px auto`, `min-height: 40px`, `border-top: 1px solid var(--fsl-border)` |
| ↑ hover / focus | `.fsl-alt:hover` | — | `background: var(--fsl-surface-2)`; focus-visible → same 2 px accent ring, offset −2 px |
| ↑ current (the player in the squad) | `[data-current="true"]` | — | `color: var(--fsl-fg)` full opacity, rank cell shows `▪`, and the swap button is replaced by the label `alts.current` in `var(--fsl-fg-dim)` |
| Rank | `.fsl-alt-rank` | 1…3 | `font: var(--fsl-fs-11) var(--fsl-font-mono)`, `color: var(--fsl-fg-dim)` |
| Name line | `.fsl-alt-name` | name · rating · position | `font-size: var(--fsl-fs-12)`, `color: var(--fsl-fg)` |
| Reason line | `.fsl-alt-reason` | one reason + signed delta | `font: var(--fsl-fs-10) var(--fsl-font-mono)`, `color: var(--fsl-fg-muted)`, `letter-spacing: 0.02em`; the delta is prefixed `−`/`+` and coloured `--fsl-success` / `--fsl-warning` |
| Price | `.fsl-alt-cost` | — | `font: var(--fsl-fs-12) var(--fsl-font-mono)`, tabular, right-aligned |
| Swap button | `.fsl-alt-swap` | — | `height: 28px; padding: 0 var(--fsl-sp-4)`, `border: 1px solid var(--fsl-border-strong)`, `border-radius: var(--fsl-r-1)`, `color: var(--fsl-fg-muted)`, `font-size: var(--fsl-fs-11)`; hover → `border-color: var(--fsl-fg); color: var(--fsl-fg)`. Hit area 28 px is acceptable on pointer; extend to `var(--fsl-hit)` with a pseudo-element when `(pointer: coarse)` |
| Overflow row | `.fsl-alts-more` | `alts.more` | `font: var(--fsl-fs-11) var(--fsl-font-mono)`, `color: var(--fsl-fg-muted)`, `text-align: left`, opens the full pool list |

Selecting an alternative: swaps the player, re-solves around the new squad, marks the row
`data-swapped="true"` for `var(--fsl-dur-4)`, and announces `a11y.swapped`.

---

## 6. "Buy these"

Only rendered when the solver used concept players, or when a solution is reachable only
by buying. Visually separated from the club cards: inset well, its own header, and a
monospace total — it must never read as part of the squad list.

| Component | Class | Props / state | Exact values |
|---|---|---|---|
| Section | `.fsl-buy` | `data-count` | `background: var(--fsl-surface-inset)`, `border-top: 1px solid var(--fsl-border-strong)`, `padding: var(--fsl-sp-5)` |
| Header | `.fsl-buy-head` | `buy.title` + `buy.count` | label `font: var(--fsl-w-semibold) var(--fsl-fs-11)/1 var(--fsl-font-mono)`, `letter-spacing: var(--fsl-track-caps)`, `text-transform: uppercase`, `color: var(--fsl-warning)` |
| Separator note | `.fsl-buy-note` | `buy.separator` | `font: var(--fsl-fs-10) var(--fsl-font-mono)`, `color: var(--fsl-fg-dim)` |
| Buy row | `.fsl-buy-row` | — | `grid-template-columns: minmax(0,1fr) 64px`, `min-height: 44px`, `border-top: 1px solid var(--fsl-border)` |
| Suggested price | `.fsl-buy-cost` | — | `font: var(--fsl-fs-12) var(--fsl-font-mono)`, tabular, right-aligned, `color: var(--fsl-fg)` |
| Market link | `.fsl-buy-link` | `buy.openMarket` | `color: var(--fsl-fg-muted)`, `text-decoration: underline`, `text-underline-offset: 2px`; hover → `color: var(--fsl-fg)` (never lighter than default) |
| Honest note | `.fsl-buy-honest` | `buy.honestNote` | `font: var(--fsl-fs-11) var(--fsl-font-ui)`, `color: var(--fsl-fg-muted)`, `border-top: 1px solid var(--fsl-border-strong)`, `padding-top: var(--fsl-sp-4)` |
| Buy total | `.fsl-buy-total` | `buy.buyTotal` | `font: var(--fsl-fs-15) var(--fsl-font-mono)`, tabular, `color: var(--fsl-fg)` |

The section carries no primary button: the honest-note line states the cost, and the
toolbar keeps the single primary action.

---

## 7. States of the panel

The panel is one component tree with a `data-view` attribute; only one view renders at a
time. Sizing of the shell never changes between views, so the panel does not jump.

| View | `data-view` | Contents | Notes |
|---|---|---|---|
| Idle | `idle` | challenge name, cost bar placeholders (`—`), one primary `panel.solve`, `states.idle.poolLine`, `states.idle.privacy` | No illustration, no greeting. A monospace status readout, then the action |
| Solving | `solving` | progress rail (5 labelled steps), 3 live counters (`lineups`, `bestCost`, `depth`), 11 skeleton rows at 34 % opacity | Rail is determinate per step: `width` transitions over `var(--fsl-dur-solve) var(--fsl-ease-in-out)`. Counters tick in mono. No spinner |
| Solved | `solved` | full header + 11 rows | Default view |
| Solved with purchases | `solved` + `data-buying="true"` | as solved, plus concept rows and the buy section | Cost bar `toBuy` cell switches to `var(--fsl-warning)` |
| No valid solution | `noSolution` | heading in `var(--fsl-warning)`, the missing-requirement list with exact deficits, closest-attempt readout, three ways forward | Never a red error box; the panel reports what is missing, not that something failed |
| Not on an SBC page | `notOnPage` | `states.notOnPage.*` + ghost `rescan` | Informational, one action |

### Solving rail step values

| Step | Key | State after |
|---|---|---|
| 1 | `states.solving.step1` | club read |
| 2 | `states.solving.step2` | pool built |
| 3 | `states.solving.step3` | search running (this is the only step that can run long; its rail cell carries a moving highlight at 1.4 s per pass, `linear`) |
| 4 | `states.solving.step4` | chemistry verified |
| 5 | `states.solving.step5` | prices attached |

---

## 8. Toolbar popup (360 px)

| Component | Class | Exact values |
|---|---|---|
| Popup body | `.fsl-popup` | `width: var(--fsl-popup-w)`, `background: var(--fsl-surface-0)`, `padding: var(--fsl-sp-5)`, `font-size: var(--fsl-fs-12)` |
| Header | `.fsl-popup-head` | brand + status chip side by side, `border-bottom: 1px solid var(--fsl-border)`, `padding-bottom: var(--fsl-sp-4)` |
| Status chip | `.fsl-status` | `data-status="solved\|solving\|idle\|error"`; solved → `var(--fsl-success)` on `var(--fsl-success-soft)`, solving → `var(--fsl-accent)`, idle/error → `var(--fsl-fg-muted)` on `var(--fsl-surface-2)`; always glyph + word |
| Mini cost row | `.fsl-popup-costs` | three cells (`cost`, `buy`, `locked`), same treatment as the cost bar at `var(--fsl-fs-12)` |
| Mini squad | `.fsl-popup-list` | first 5 slots + `+6` overflow row, 26 px rows, mono position + truncated name + cost. No lock buttons here — the popup is read-only |
| Footer | `.fsl-popup-foot` | `popup.openPanel` as the single primary action (full width, 34 px), `popup.settings` as a ghost link |
| Constraint | — | No scrolling: the popup is fixed-height content, overflow is cut by the list cap |

---

## 9. Options page

| Component | Class | Exact values |
|---|---|---|
| Page | `.fsl-options` | `max-width: var(--fsl-options-w)`, `margin-inline: auto`, `padding: var(--fsl-sp-8) var(--fsl-sp-7)` |
| Group | `.fsl-group` | `border-top: 1px solid var(--fsl-border)`, `padding-block: var(--fsl-sp-8)`; first group has no top border |
| Group title | `.fsl-group-title` | `font-size: var(--fsl-fs-15)`, `font-weight: var(--fsl-w-semibold)`, `color: var(--fsl-fg)` |
| Group body | `.fsl-group-body` | `font-size: var(--fsl-fs-12)`, `color: var(--fsl-fg-muted)`, `max-width: 62ch` |
| Setting row | `.fsl-setting` | `display: grid; grid-template-columns: 1fr auto; gap: var(--fsl-sp-5); align-items: center; min-height: var(--fsl-hit)` |
| Value readout | `.fsl-setting-value` | mono, tabular, `color: var(--fsl-fg)`, right-aligned — every slider and switch shows its real number, never a vague word |
| Slider | `.fsl-range` | track `height: 4px`, `background: var(--fsl-surface-2)`, `border-radius: var(--fsl-r-pill)`; filled portion `var(--fsl-accent-deep)`; thumb 16 px circle, `background: var(--fsl-fg)`, `border: 2px solid var(--fsl-surface-0)`; focus-visible → accent ring |
| Switch | `.fsl-switch` | `44×24`, `border-radius: var(--fsl-r-pill)`; off → `background: var(--fsl-surface-2)`, `border: 1px solid var(--fsl-border-strong)`; on → `background: var(--fsl-accent-deep)`, border `var(--fsl-accent-deep)`; knob 18 px `var(--fsl-fg)`, translates 20 px over `var(--fsl-dur-2)` |
| Segmented control | `.fsl-seg` | 2–3 options, `height: var(--fsl-ctl)`; selected → `background: var(--fsl-surface-2)`, `color: var(--fsl-fg)`, `box-shadow: inset 0 0 0 1px var(--fsl-border-strong)`; unselected → `color: var(--fsl-fg-muted)`, transparent |
| Cost-model weights | `.fsl-weights` | four sliders, each 0.00–1.00, step 0.05, value shown as `0.85`. Order is fixed: duplicate-untradeable, untradeable, tradeable, concept |
| Effort control | `.fsl-effort` | 5 steps, labelled `fast` / `balanced` / `thorough` at the ends and middle; hint line carries the real number of lineups: `niveau 3 af 5 · op til 2 400 opstillinger` |
| Danger row | `.fsl-danger-row` | `fsl-options.reset` styled with `--fsl-danger` text on transparent, `border: 1px solid color-mix(in oklch, var(--fsl-danger) 45%, transparent)`; hover → `background: var(--fsl-danger-soft)`. Only destructive-styled control on the page |

---

## 10. Icons and keyboard

Icon set: `assets/logo-mark.svg` — a FUT card with its top-right corner chamfered, holding a
four-node formation, on a 32-unit grid. Outline card plus solid formation, both in `currentColor`,
so one file covers the dark panel, a light surface and the accent surface. Nodes and connectors are
one path unioned by winding; do not split them into separate shapes.

| File | Rendered at | Geometry changes |
|---|---|---|
| `assets/logo-mark.svg` | ≥ 20 px | card 24.8 u, radius 4.6, chamfer 8.4, outline 1.9, forward r 2.4, back 3 × r 2.0, connectors 1.5 |
| `assets/logo-mark-16.svg` | 14–19 px | card 28.8 u, radius 6.0, chamfer 8.8, outline 2.6, forward r 3.3, back 2 × r 3.0, connectors 2.4 |
| `assets/icon-tile.svg` | ≥ 24 px, PNG 32+ | filled `#0a0f14` card, rim 0.9 at 24%, formation `#1fdde0` |
| `assets/icon-tile-16.svg` | 16 px slot | same, rim 1.6 at 45%, formation re-cut as the 16 px lockup |

Below 20 px the master's outline lands on 0.95 px and its connectors fuse into a blob, so the 16 px
file is a re-cut of the same idea, not a scaled copy. Never downscale one PNG to produce another size.
Clear space is the 3.6 units already inside every file; nothing is placed in it.
Test sizes 16 / 32 / 48 / 128 px and the misuse cases are presented in `logo.html`; `reference/vision.html`
shows the same marks in the panel's own context.

Inline glyphs (14 px, `stroke-width: 1.6`, `viewBox="0 0 16 16"`): lock, pin, chevron,
swap-arrows, market-external, broken-link, duplicate-squares, plus, warn-triangle.
No icon font, no emoji, no raster.

| Key | Action | Scope |
|---|---|---|
| `Tab` / `Shift+Tab` | Move between slots, lock buttons, alternatives, buy links | Panel |
| `↑` / `↓` | Move to the previous / next slot row | While a row has focus |
| `Enter` / `Space` | Open or close that row's alternatives; activate a focused control | Row / control |
| `Esc` | Close the open alternatives, return focus to its row | Alternatives |
| `↑` / `↓` inside alternatives | Move between ranked alternatives | Alternatives open |
| `Enter` on an alternative | Swap that player in | Alternatives open |
| `L` | Toggle the lock on the focused row | Row focused |
| `S` | Solve / re-solve | Panel |

Focus is never moved by a re-solve: the row that had focus keeps it, and the live region
announces the new cost. The alternatives region is `role="group"` with
`aria-label="alts.title"`; the row's toggle is `aria-expanded` + `aria-controls`.

---

## 11. Motion

| Animation | Duration | Easing | Property |
|---|---|---|---|
| Row hover / focus wash | `--fsl-dur-1` | `--fsl-ease-out` | `background-color` |
| Alternatives expansion | `--fsl-dur-2` | `--fsl-ease-out` | `grid-template-rows`, `opacity` |
| Cost counter settling | `--fsl-dur-3` | `--fsl-ease-settle` | counts value, `translateY(2px → 0)`, `opacity .6 → 1` |
| Swapped-row confirmation | `--fsl-dur-4` | `--fsl-ease-settle` | `background-color`, then fades to `--fsl-surface-1` |
| Solver rail pass | `--fsl-dur-solve` | `--fsl-ease-in-out` / `linear` for the moving cell | `width`, `background-position` |
| Switch knob | `--fsl-dur-2` | `--fsl-ease-in-out` | `transform` |

Nothing else animates. No parallax, no glow pulsing, no decorative shimmer.
Under `prefers-reduced-motion: reduce` every duration collapses to `0.01ms`, the cost
counter jumps to its final value instead of counting, and the solver's moving cell becomes
a static step state.
