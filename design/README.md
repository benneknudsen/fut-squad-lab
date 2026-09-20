# FUT Squad Lab — design handoff

Free, open-source Chrome extension (Manifest V3) that solves one Squad Building Challenge at a
time using the club's own cards, and shows its reasoning. No backend, no account, no telemetry.
MIT. Unofficial: it uses no EA-owned asset, mark, badge, crest or player likeness anywhere.

This folder is the design contract for the implementation. The screens are specified in tokens
and components rather than in markup, because the panel is injected into EA's web app and its
stylesheet must survive that app changing between game versions.

---

## 1. Read the bundle in this order

| # | File | What it answers |
|---|---|---|
| 1 | `README.md` (this file) | Scope, principles, token contract, states, acceptance criteria |
| 2 | `tokens.css` | The complete token set. **Single source of truth** for colour, type, space, radii, motion |
| 3 | `components.md` | Every component with props, states and exact values |
| 4 | `copy.da.json` / `copy.en.json` | All 202 UI strings in Danish and English. No string is hardcoded |
| 5 | `reference/vision.html` | The visual reference. Open it in a browser — read it, don't copy it |
| 6 | `assets/` | The mark, its 16 px optical variant, the app-icon tiles, the two lockups, and the PNG exports. `logo.html` at the project root presents them |
| 7 | `tools/` | Two checks you can run: contrast measurement and a functional DOM test |

`reference/vision.html` is a reference board, not production code: it inlines a subset of the
copy and a mirror of the token block so it renders standalone. The build follows `tokens.css`
and `copy.*.json`.

---

## 2. Principles

1. **Density is the feature.** Eleven slots, a cost summary and an open alternatives list have
   to coexist in a 320–420 px column. Every pixel of padding has to justify itself.
2. **Numbers are content.** Cost, rating and chemistry get the monospace face, tabular figures
   and a fixed column. They are never centred, never animated decoratively, and never rounded.
3. **One accent.** Cyan appears on the primary action and on the concept/buy state — nothing
   else. Semantic meaning uses the semantic tokens, not the accent.
4. **Dark first, and its own dark.** The panel carries its own token set and never reads a host
   variable. It should look like it belongs in a dark game UI without borrowing that UI.
5. **States are not colours.** Every card state is a colour *plus* a glyph *plus* a word.
6. **No decoration.** No mascots, no gradient washes, no glassmorphism, no oversized rounded
   cards, no emoji as icons. Motion exists to explain a change, not to entertain.

---

## 3. Token contract

Full set in `tokens.css`. Every property is prefixed `--fsl-` and every component class is
prefixed `fsl-`, because the stylesheet is injected next to a host app whose own custom
properties change between game versions. `--fsl-*` cannot collide; `--surface` could.

| Group | Tokens |
|---|---|
| Surfaces (3 levels + well) | `--fsl-surface-0` panel body · `--fsl-surface-1` rows/header · `--fsl-surface-2` hover/open/locked · `--fsl-surface-inset` cost bar, alternatives, buy list |
| Lines | `--fsl-border` decorative hairline · `--fsl-border-strong` control outlines · `--fsl-border-inverse` locked row |
| Text | `--fsl-fg` · `--fsl-fg-muted` · `--fsl-fg-dim` |
| Accent | `--fsl-accent` (cyan) · `--fsl-accent-fg` · `--fsl-accent-deep` · `--fsl-accent-soft` · `--fsl-accent-line` |
| Semantic | `--fsl-success` · `--fsl-warning` · `--fsl-danger` (+ `-soft` variants) |
| Card state | `--fsl-state-tradeable` `-untradeable` `-duplicate` `-concept` (+ `-bg` variants) |
| Type | `--fsl-font-ui` · `--fsl-font-mono` · `--fsl-font-display` · 7 sizes · 3 line heights · 3 tracking steps |
| Space / shape | 5-step 4 px grid · 3 radii + pill |
| Sizing | `--fsl-panel-min/default/max` (320/400/420) · `--fsl-ctl` 32 · `--fsl-hit` 44 |
| Motion | 4 durations + `--fsl-dur-solve` · 3 easings |
| Elevation | `--fsl-shadow-panel` · `--fsl-shadow-popover` |

Semantic colours, deliberately: **cyan** is the one decorative accent; **lime** means "stays in
your club"; **amber** means "this card is spent or must be bought"; **red** is reserved for the
destructive reset on the options page and **never** appears in the panel — "no valid solution"
is a warning with an explanation, not an error.

### Measured contrast

Produced by `tools/contrast-check.py` (OKLch → sRGB → WCAG). Every text pair clears AA.

| Pair | Ratio | Pair | Ratio |
|---|---|---|---|
| `--fsl-fg` on surface-1 | 16.1:1 | `--fsl-fg-dim` on surface-1 | 5.2:1 |
| `--fsl-fg-muted` on surface-1 | 7.9:1 | accent on surface-1 | 10.6:1 |
| `--fsl-fg` on surface-0 | 17.4:1 | success / warning / danger on surface-1 | 11.3 / 10.4 / 6.4:1 |
| `--fsl-fg-dim` on surface-2 | 4.6:1 | `--fsl-accent-fg` on the accent fill | 11.1:1 |
| accent text on its own 16 % tint | 7.5:1 | warning text on its own 16 % tint | 7.5:1 |
| success text on its own 16 % tint | 7.9:1 | danger text on its own 16 % tint | 5.1:1 |

Hairline `--fsl-border` measures 1.3:1 against the surfaces. That is intentional: it is a
decorative separation line, never a functional boundary. The only functional boundary is the
focus ring, which uses `--fsl-accent` (10.6:1).

---

## 4. Component inventory

Full specification with props, states and exact values in `components.md`.

| Component | Classes | Notes |
|---|---|---|
| Injection root | `.fsl-root` | Owns the palette; a light theme is a second block here, not a fork of the components |
| Panel | `.fsl-panel` | `container-type: inline-size`; the width control drives `--rb-panel-w` / the host column width |
| Header | `.fsl-head` `.fsl-head-title` `.fsl-badge` `.fsl-head-sub` | Challenge, set, formation, unofficial badge |
| Cost bar | `.fsl-costbar` `.fsl-costbar-main` `.fsl-costbar-sub` | Two headline cells + one dense secondary line; `aria-live="polite"`, announced as one string |
| Toolbar | `.fsl-toolbar` `.fsl-btn-primary` `.fsl-btn-ghost` | One primary action per surface; stays mounted and disables while solving |
| Slot row | `.fsl-row` `.fsl-pos` `.fsl-ident` `.fsl-ident-top` `.fsl-meta` `.fsl-cost` `.fsl-lock` | Two lines, 46 px, at every width |
| Card-state chip | `.fsl-chip` | 4 states × (colour + glyph + word); glyph-only below 348 px |
| Alternatives | `.fsl-alts` `.fsl-alt` `.fsl-alt-reason` `.fsl-alt-swap` | Inline expansion under its row — a floating popover would cover the row it belongs to at 320 px |
| Buy list | `.fsl-buy` `.fsl-buy-row` `.fsl-buy-total` `.fsl-buy-honest` | Shopping list, separated from the club cards, with the coin total stated plainly |
| Empty / solving views | `.fsl-view` `.fsl-step` `.fsl-skeleton` `.fsl-missing` `.fsl-fix` | Every non-solved state |
| Popup | `.fsl-popup` `.fsl-status` `.fsl-popup-costs` `.fsl-popup-list` | 360 px, fixed height, five slots then `+6`, no scrolling |
| Options | `.fsl-options` `.fsl-group` `.fsl-setting` `.fsl-range` `.fsl-switch` `.fsl-seg-ctl` | Real values in mono next to every control |

The seed class system from the Web Prototype skill is present in `reference/vision.html` for the
board chrome only (`rb-*`). Production components use `fsl-*` exclusively.

---

## 5. States

| State | `data-view` | Content | Primary action |
|---|---|---|---|
| Idle | `idle` | Challenge read, cost bar as `—`, club-pool readout, privacy line | `panel.solve` (full width, in-view) |
| Solving | `solving` | Five-step rail, four live counters, 11 skeleton rows, toolbar with a disabled primary | Disabled |
| Solved | `solved` | 11 slots, cost bar, summary footer | `panel.resolve` |
| Solved with purchases | `solved`, `data-buying="true"` | Concept rows, buy list, `to buy` cell in amber | Unchanged |
| No valid solution | `noSolution` | Exact deficits, closest attempt, three ways forward | None — three secondary paths |
| Not on an SBC page | `notOnPage` | Explanation, rescan | One ghost action |

Three rules that hold across all six:

- **The panel never moves between states.** Header and cost bar keep their height, so the column
  does not jump when a solve finishes.
- **The solving state is not a spinner.** It names the five steps it is running and shows real
  numbers (lineups tested, best cost so far, depth, elapsed).
- **"No valid solution" explains the deficit** in the challenge's own vocabulary — *3 more
  leagues*, *chemistry short by 12*, *no eligible card for RW* — and offers the honest way out
  (buy two cards for about 9,800 coins) before it offers to relax the challenge.

---

## 6. Copy contract

- 202 keys per language, identical key sets, identical placeholders in both files. The smoke
  test verifies that the reference page's inline copy is a faithful subset of both files.
- Nested, dotted paths (`states.noSolution.fixBuy`), placeholder syntax `{count}`.
- **All strings are translatable. Nothing is hardcoded**, including the micro-labels
  (`{rating} OVR`, `L31`, `N7`) and the state words on the chips.
- **Numbers are formatted per locale**, not concatenated: `Intl.NumberFormat("da-DK")` renders
  `16.140`, `en-GB` renders `16,140`. Same data, different separator — the panel shows Danish
  grouping to a Danish user.
- No plural logic yet: the copy avoids it ("3 kort", "3 cards" read correctly for every count in
  range). If a string ever needs plurals, add ICU plurals in both files rather than string
  arithmetic.
- Danish uses real diacritics (`Løs igen`, `kan ikke sælges`, `Skånsom tilstand`). Never
  transliterate to `Loes`/`saelges` — the author is Danish and the UI ships in Danish.

---

## 7. Icons and the trademark position

The mark is a **FUT card with its top-right corner chamfered, holding a four-node formation**:
the card is what the product manipulates, the formation is what it builds, and the chamfer is the
corner the solver did not spend. It is drawn on a 32-unit grid — card 24.8 units across, chamfer a
true 45°, 3.6 units of clear space built into every file. `logo.html` presents it (construction,
lockups, icon set, misuse) and is the thing to show a reviewer.

- `assets/logo-mark.svg` — the master, for 20 px and up. Outline card plus solid formation, drawn in
  `currentColor` so one file covers the dark panel, a light surface and the accent surface. Nodes and
  connectors are one path unioned by winding, so there is no seam where they meet.
- `assets/logo-mark-16.svg` — the 16 px optical variant. Below 20 px the master's 1.9 stroke lands on
  0.95 px and the connectors fuse into a blob, so this file is re-cut: outline 2.6, three nodes instead
  of four, connectors 2.4. Use it from 14 px, and nothing else.
- `assets/icon-tile.svg` / `assets/icon-tile-16.svg` — the app icon: the mark on its own surface
  (`#0a0f14`, tokens.css `--fsl-surface-0`), formation in the accent (`#1fdde0`, `--fsl-accent`), plus a
  rim light so a near-black tile still separates from a dark toolbar. The 16 px cut carries a 45% edge
  instead of 24%.
- `assets/icons/icon-16 · 32 · 48 · 128 · 512.png` — the exports for the manifest and the store listing.
  16 comes from `icon-tile-16.svg`, the rest from `icon-tile.svg`. Never downscale one PNG to another size.
- `assets/wordmark.svg` / `assets/wordmark-stacked.svg` — lockups. Uppercase 600 weight at 0.12 em
  tracking, tagline in mono caps at 0.55 opacity, type on the system UI stack so nothing is fetched.
  The type is live text, not outlines: outline it before print or a social preview. Minimum widths
  140 px (horizontal) and 96 px (stacked).
- Minimum sizes: mark 20 px, 16 px cut 14 px, tile 24 px. Clear space is the 3.6 units already in the files.
- Inline glyphs at 14 px, 1.6 stroke, 16-unit grid: lock, unlock, swap arrows, broken link,
  duplicate squares, plus, warning triangle, search, off.
- Export PNGs at 16 / 32 / 48 / 128 from the SVGs for the manifest; nothing else is needed.

**No EA-owned asset, logo, badge, club crest, league mark or player likeness is used, and none
may be added.** The README of the extension states that it is unofficial. Every player row in
the design is a structural placeholder (`Player 04`, `84 OVR · L31 N07 C12`) precisely so that
no real player's identity is reproduced.

---

## 8. Accessibility requirements

- Slot rows are reachable as buttons (`Tab`), `↑`/`↓` move between rows, `Enter`/`Space` opens
  alternatives, `Esc` returns focus to the row, `L` toggles the lock, `S` re-solves.
- Focus never moves on a re-solve or a swap; the row that had focus keeps it and the cost bar
  announces the new total.
- The cost bar is a single `aria-live="polite"` region: one announcement, not five.
- Alternatives are a labelled group; the row's toggle carries `aria-expanded` and, when open,
  `aria-controls`. The buy list and the squad list each carry a name including their count.
- Every chip carries `title` and `aria-label` with the state's meaning in words — this matters
  most below 348 px, where the visible word is dropped.
- Lock toggles are `aria-pressed` buttons with names that include the player.
- Focus rings are 2 px `--fsl-accent` with a 2 px offset, or −2 px inset inside rows so they
  cannot clip at 320 px.
- `prefers-reduced-motion: reduce` collapses every duration to 0.01 ms, makes the cost counter
  jump to its final value, and turns the solver's moving step into a static state.

---

## 9. Acceptance criteria

| Criterion | How it is met | How it is checked |
|---|---|---|
| Panel fully readable at 320 px with 11 slots, cost summary and alternatives open | Row grid reflows at 348 px of container width (container query, not a viewport breakpoint); chip drops to glyph; no horizontal scroll | `tools/vision-smoke-test.js`: rows, alternatives and width budget at 320 px |
| Every state designed, including "no valid solution" explaining what is missing | Six views, each with its own content and action | Test walks all six views and asserts the deficit list and the three ways forward |
| Locked / tradeable / untradeable / duplicate / concept distinguishable without colour | Glyph + word + colour on every chip; locked rows use a neutral outline and a pin, never a warning colour | Test asserts every chip has a glyph, a word and a description |
| Numbers use tabular figures and align in columns | `--fsl-font-mono` + `font-variant-numeric: tabular-nums` on every figure; fixed-width cost column, right-aligned | Contrast/typography tokens; test asserts the tabular declaration is present |
| Panel reads as belonging in a dark game UI | Own dark token set, three surfaces, hairline separations, condensed uppercase headings, no light-mode assumptions | `reference/vision.html` shows it against a simulated host column |
| All copy in Danish and English | 202 keys × 2, identical sets and placeholders | Test asserts subset fidelity and that no language leaks into the other |
| Icon legible at 16 px | A re-cut 16 px file: outline 2.6, three nodes, connectors 2.4 — the scaled master fuses into a blob | Shown at 16 / 32 / 48 / 128 px on a checkerboard and on light and dark toolbar strips in `logo.html` |
| Focus states and keyboard navigation specified for rows and the alternatives | Full key map in §8 and in `components.md` §10 | Test asserts focusable toggles, `aria-expanded`, `aria-controls`, `aria-pressed` |
| Zero EA-owned trademarks, logos or assets | Placeholder identities only; mark is original | Test greps for EA marks, crest and likeness references |
| One primary action per surface | Solve / solve-again / buy are one action in three states | Test asserts exactly one primary per view, and none in `noSolution` |

Run the checks yourself:

```bash
python3 tools/contrast-check.py                                   # token contrast table
cd /tmp && mkdir -p fsl-test && cd fsl-test && npm i jsdom        # one-time
NODE_PATH=/tmp/fsl-test/node_modules node tools/vision-smoke-test.js reference/vision.html
```

The smoke test runs the reference page's real script against a DOM and asserts 72 properties:
row count, chip semantics, every view, both languages, the width budget at 320 and 400 px, and
that the inline copy is a faithful subset of `copy.*.json`.

---

## 10. Implementation notes for the extension

- **Ship `tokens.css` as a file, not inline styles.** MV3's CSP blocks inline `<style>` in some
  contexts and makes review harder. Link the stylesheet and keep the panel's markup in a
  template string.
- **Scope everything.** All selectors under `.fsl-root`; all custom properties prefixed
  `--fsl-`. Do not style `body`, `html`, `*` or any host class.
- **Do not read host CSS variables.** They change between game versions. Read the DOM for
  challenge data, never the host's stylesheet for presentation.
- **Container queries, not media queries,** for the panel's internal reflow: the viewport is the
  player's browser, the container is the injected column. Breakpoint: 348 px.
- **Colours are `oklch()`.** Chrome 111+ has it; MV3 targets far newer. Keep the fallback simple
  — no hex duplicates, so there is one value to maintain.
- **Motion budget: five durations** (`--fsl-dur-1…4` plus `--fsl-dur-solve`). If a new animation
  needs a sixth, it does not belong in the panel.
- **Icon exports** come from the two SVGs; the manifest should point at PNGs at 16, 32, 48 and
  128 px rendered from them.

---

## 11. Deliberately out of scope

- No website, landing page or marketing surface — the extension's README on GitHub is the
  marketing.
- No onboarding tour, no mascots, no "welcome" empty states. The idle state is a status readout
  and one button.
- No real player names, clubs, leagues or nations in any design artefact.
- No light theme in this round. `tokens.css` is structured so a light theme is a second
  `.fsl-root` block; the panel lives inside a dark app, so dark ships first.

---

## 12. Open decisions for the author

These are the places where the design records a choice that the solver's real behaviour should
confirm. None of them block implementation.

1. **Cost weights.** The four fodder weights (duplicate 0.10, untradeable 0.70, tradeable 1.00,
   concept 2.00) are a **borrowed published heuristic**: the percentages SBC Monkey describes in
   its public documentation for how it values fodder. This project is not affiliated with SBC
   Monkey, and the numbers are not claimed to be tuned, measured or correct — they are someone
   else's reasonable defaults, adopted because they are more defensible than values we invented.
   The sliders expose them so a player can correct them without a new build, which is exactly why
   they remain configurable.
2. **Per-row cost contribution.** The panel shows a card's weighted contribution (`320`), not
   its market value, on the theory that consuming an untradeable card costs you less than
   consuming a tradeable one. If the solver prices differently, the row shows whatever the
   solver returns — the layout does not care.
3. **Buy-list prices.** "Suggested price" is a quote, not an offer. If the market data is stale
   the honest-note line should say so rather than show a stale total confidently.
4. **Chemistry and average rating** appear as summary readouts. If the solver returns a
   chemistry breakdown per player, the row has room for one more mono token.
5. **The popup's five-slot cap** is a fixed-height decision. If the author prefers seven, the
   popup grows by 52 px and stops being scroll-free at small window heights.

---

## 13. In this repository

This bundle lives at `design/` and is the design contract for `src/ui/`. One file was added
on import so the documented checks run inside this ES-module repository:

- `tools/package.json` pins `tools/` to CommonJS — the repository's root `package.json`
  sets `"type": "module"`, which otherwise makes the smoke test fail on `require`.

In-repo run form:

```bash
cd design
python3 tools/contrast-check.py                                     # token contrast table
NODE_PATH=/tmp/fsl-test/node_modules node tools/vision-smoke-test.js reference/vision.html
```

The jsdom dependency is one-time: `cd /tmp && mkdir -p fsl-test && cd fsl-test && npm i jsdom`.

Verified on import: the contrast check reports 0 failures, and the smoke test asserts 72
properties and prints `RESULT: PASS`.

Production code follows `tokens.css` and `copy.*.json`; `reference/vision.html` is a
reference board to read, not markup to copy. `logo.html` presents the mark and the icon set.

