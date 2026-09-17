# AGENTS.md — FUT Squad Lab

Conventions for any agent (human or automated) working in this repository.
Read this file in full before making changes.

## What this project is

A Chrome extension (Manifest V3) that solves **one EA SPORTS FC 27 Ultimate Team
Squad Building Challenge at a time** using the player's own club, minimising
fodder cost. Everything runs locally; there is no backend.

The full design, architecture and milestone plan is in [`docs/PLAN.md`](docs/PLAN.md).
**Read it before implementing anything** — it contains the verified FC27 API
surface and the requirement model, which this project depends on.

## Hard rules

1. **No EA-owned assets.** Never add EA logos, club crests, league badges, kit
   images, player photos or any other trademarked asset. This is a public,
   unofficial project.
2. **No personal data in the repository.** No account identifiers, persona IDs,
   email addresses, or real captured club contents. Test fixtures must stay
   sanitised — see `test/fixtures/README.md`.
3. **The solver core stays pure.** Everything under `src/solver/` must have no
   DOM access, no `chrome.*` APIs, and no network calls. It takes plain data in
   and returns plain data out. This is what makes it unit-testable without a
   browser, and it is not negotiable.
4. **All EA-specific naming lives in `src/ea/adapter.js`.** Class names, endpoint
   paths and payload shapes are volatile — EA renamed things between FC26 and
   FC27. Exactly one file may know about them.
5. **No new runtime dependencies without explicit approval.** The extension ships
   with zero runtime dependencies by design (keeps the repo MIT-clean and the
   review surface small). `vitest` is a devDependency and is currently the only
   permitted one.
6. **No auto-submit.** The extension fills a squad. It must never submit a
   challenge on the user's behalf.

## Design contract

`design/` is the design contract for `src/ui/`. It is the **sole** source for colour,
typography, spacing, motion and UI copy.

**The authoritative document is `design/README.md`.** Read it before any UI work.

> **`design/DESIGN-HANDOFF.md` is OpenDesign's generic boilerplate and does NOT apply
> here.** It instructs you to start from `logo.html`, to map HTML screens to routes, and
> it discusses landing pages, OS widgets and React/Vue/SwiftUI targets. There is none of
> that in this project: our UI is a panel injected into someone else's web app. Where
> `DESIGN-HANDOFF.md` and `design/README.md` disagree, **`design/README.md` wins.**

Rules that follow from the contract:

1. **No invented styles.** Colour, type, space, radii and motion come from
   `design/tokens.css`. Do not add hex values, do not invent a token, do not reach for a
   framework default.
2. **No invented copy.** Every UI string exists in `design/copy.da.json` and
   `design/copy.en.json`. Nothing is hardcoded, including micro-labels and the state
   words on chips.
3. **Scope everything.** All selectors live under `.fsl-root`; all custom properties are
   prefixed `--fsl-`. Never style `body`, `html`, `*`, or any host class.
4. **Never read the host's CSS variables.** They change between game versions. Read the
   DOM for challenge data; never read the host stylesheet for presentation.
5. **Container queries, not media queries**, for the panel's internal reflow. The
   viewport is the player's browser; the container is the injected column. Breakpoint:
   348 px.
6. **`design/reference/vision.html` is a reference board to read, not markup to copy.**
7. **No EA-owned asset** may be added at any point. The design uses placeholder player
   identities deliberately.

Run the bundle's own checks before claiming UI work is done:

```bash
cd design
python3 tools/contrast-check.py                                     # token contrast table
NODE_PATH=/tmp/fsl-test/node_modules node tools/vision-smoke-test.js reference/vision.html
```

The jsdom dependency is one-time: `cd /tmp && mkdir -p fsl-test && cd fsl-test && npm i jsdom`.

## Repository layout

```
manifest.json          MV3 manifest
src/
  page-bridge.js       MAIN world — hooks EA objects, injects the solve button
  content.js           ISOLATED world — relay between page and extension
  background.js        service worker — price fetching + cache
  ea/
    adapter.js         the ONLY file that knows EA class/API names
    challenge-reader.js
    club-reader.js
    squad-writer.js
  solver/
    requirements.js    elgReq[] -> normalised constraint set
    chemistry.js
    candidates.js
    prices.js
    validate.js
    solve.js
    worker.js
  ui/
    panel.js
    options.html / options.js
    styles.css
test/
  fixtures/            sanitised real FC27 payloads
  *.test.js
docs/
  PLAN.md
```

Some of these files do not exist yet — they are created by the milestone issues.

## Code conventions

- **Plain ES modules. No framework, no bundler, no build step.** The extension
  loads directly as static files via `Load unpacked`.
- **No TypeScript.** Vanilla JS with JSDoc where a type genuinely helps. This is a
  deliberate choice to keep the extension dependency-free and the diff small.
- Target: current Chrome only (MV3). No transpilation, no polyfills.
- **Style is scoped CSS.** The panel is injected into EA's page, so styles must be
  namespaced under a single root class and must not leak into EA's DOM. Never
  depend on EA's own class names or CSS variables — they change between game
  versions.
- Numeric UI (cost, rating, chemistry) uses tabular figures.

## Testing

```bash
npm test -- --run --reporter=dot
```

- Tests are **vitest**, run against the sanitised fixtures in `test/fixtures/`.
- The solver core is where the test coverage lives. It is pure, so it needs no
  browser and no mocking of Chrome APIs.
- **Never write a test whose assertion cannot fail.** If a mock makes the
  assertion vacuous, the test is worthless — reviewers will reject it.
- If a change produces a bug fix, demonstrate it with a RED/GREEN proof: remove
  the fix, confirm the test fails, restore the fix, confirm it passes.

## Working with the FC27 web app

The project depends on EA's internal objects and endpoints, which are undocumented
and change without notice. Verified facts live in `docs/PLAN.md` §1. Do not guess
at class names or endpoints — read the plan, or capture a fresh trace.

Known facts worth repeating here:

- EA's SBC classes are reachable on the page's `window` (e.g. `UTSBCService`,
  `UTSBCChallengeEntity`, `UTSBCSquadDetailPanelViewController`).
- The requirement model is the classic one: `elgReq[]` entries of
  `{ type, eligibilitySlot, eligibilityKey, eligibilityValue }`.
- Item payloads already contain EA's own price fields (`marketAverage`,
  `discardValue`) — use them as the offline fallback before reaching for an
  external price source.

## Commits

Conventional commits, with an issue reference:

```
feat(solver): decode elgReq into normalised constraints (#1)
```

One issue per branch. Never commit on a red test run.
