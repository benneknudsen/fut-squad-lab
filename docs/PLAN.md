# FC27 SBC Solver — Chrome Extension Implementation Plan

**Goal:** A self-written Chrome extension that solves a single EA SPORTS FC 27 Ultimate Team Squad Building Challenge from the user's own club, minimising fodder cost — fully local, no paid backend.

**Product name:** **FUT Squad Lab** (display name and store listing: **"FUT Squad Lab | FC27 SBC Solver"**, the same convention the incumbent uses — "AutopilotSBC | FC26 SBC Solver"). Repo: `fut-squad-lab`.

**License:** MIT.

**Architecture:** Three layers in one MV3 extension. (1) A *page bridge* injected into the FC27 web app that reads club/challenge data and writes the solution back through EA's own objects. (2) A *pure solver core* with no DOM dependency, unit-testable against captured fixtures. (3) An *extension shell* (service worker + panel) for prices, settings and UI.

**Tech Stack:** Vanilla ES modules (no framework), Web Worker, Chrome MV3, Vitest for the solver core. Build step: none required (static files, `Load unpacked`). Node 20+ only for tests.

**Status:** Plan only. No implementation until approved.

---

## 1. Verified facts (from live FC27 recon, 2026-09-17)

Recon captured 30 network calls from the real FC27 web app. Raw file:
`recon-data/fc27-recon-01.json` (279 KB). Findings that the whole design rests on:

### 1.1 EA's SBC classes are reachable on `window`

The recon probe resolved all of these as real constructors **on the page's `window`**:

| Global | Type | Methods |
|---|---|---|
| `UTSBCService` | function | 17 |
| `UTSBCRepository` | function | 11 |
| `UTSBCChallengeEntity` | function | 48 |
| `UTSBCSetEntity` | function | 16 |
| `UTSBCFactory` | function | 7 |
| `UTSquadBuildingChallengeDAO` | function | 7 |
| `UTSBCSquadDetailPanelView` | function | 13 |
| `UTSBCSquadDetailPanelViewController` | function | 18 |
| `UTSBCSquadOverviewViewController` | function | 22 |
| `UTSBCHubViewController` | function | 20 |
| `UTSBCChallengesViewController` | function | 17 |
| `UTSBCConfirmSubmissionPopupViewController` | function | 7 |
| `UTSBCSquadStatsView` | function | 8 |
| `UTSquadEntity` | function | 60 |
| `SBCEligibilityKey` | object | enum table |
| `services` | object | EA service locator |

**Why it matters:** monkey-patching a prototype from a `world: "MAIN"` content script is viable. This was the single biggest technical risk and it is now closed.

### 1.2 API surface (host `utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/`)

| Method | Path | Used for |
|---|---|---|
| GET | `/sbs/sets` | all SBC sets, grouped by category |
| GET | `/sbs/setId/{setId}/challenges` | challenges in a set, **including requirements** |
| POST | `/sbs/challenge/{id}` | current squad state for one challenge |
| GET | `/sbs/challenge/{id}/squad` | same, read-only variant |
| POST | `/club` | club item search (paged) |
| GET | `/purchased/items` | storage / duplicate pile |
| GET | `/squad/active`, `/squad/list` | squad read |
| PUT | `/squad/{id}` | **apply a built squad** |
| GET | `/chemistry/profiles`, `/chemistry/teamlinks` | chemistry rule set |
| GET | `/usermassinfo` | credits / club info |

### 1.3 The requirement model (the important one)

`GET /sbs/setId/10/challenges` returns, per challenge:

```json
{
  "challengeId": 25,
  "name": "3 Leagues & 2 Nations",
  "formation": "f343",
  "elgOperation": "AND",
  "type": "OPEN_CHALLENGE",
  "repeatable": false,
  "elgReq": [
    { "type": "LEAGUE_COUNT",      "eligibilitySlot": 1, "eligibilityKey": 8,  "eligibilityValue": 3 },
    { "type": "SCOPE",             "eligibilitySlot": 1, "eligibilityKey": 13, "eligibilityValue": 2 },
    { "type": "NATION_COUNT",      "eligibilitySlot": 2, "eligibilityKey": 7,  "eligibilityValue": 2 },
    { "type": "SAME_LEAGUE_COUNT", "eligibilitySlot": 3, "eligibilityKey": 5,  "eligibilityValue": 6 },
    { "type": "SAME_NATION_COUNT", "eligibilitySlot": 4, "eligibilityKey": 4,  "eligibilityValue": 6 },
    { "type": "PLAYER_QUALITY",    "eligibilitySlot": 5, "eligibilityKey": 3,  "eligibilityValue": 3 },
    { "type": "CHEMISTRY_POINTS",  "eligibilitySlot": 6, "eligibilityKey": 35, "eligibilityValue": 30 }
  ],
  "awards": [ { "type": "pack", "value": 519, "count": 1 } ]
}
```

**This is the classic SBC constraint model — the same family AutoPilot-SBC compiles to GLPK.** No "streamlined score" system is present in the web app. Chemistry, ratings, nation/league/club counts and brick scope all still apply.

### 1.4 Item format

`POST /club` returns `{ "items": [ ... ] }`. Each item carries everything the solver needs:

- `rating` (84) — rating/quality constraints
- `nation` (52), `leagueId` (31), `teamid` (1745) — nation/league/club counting
- `rareflag` (0), `cardsubtypeid` (2), `playStyle` (250), `plusRoles` — rarity & special cards
- `preferredPosition`, `possiblePositions` — formation slot fitting
- `untradeable` (false), `pile` (7), `owners` (1), `isCollected` — fodder economics & duplicate logic
- `marketAverage` (1100), `marketDataMinPrice` (600), `marketDataMaxPrice` (10000), `discardValue` (596) — **EA's own price data, already in the payload**
- `resourceGameYear` (2027) — confirms FC27

### 1.5 Chemistry rules are small and self-contained

`GET /chemistry/profiles`:

```json
{ "version": 3,
  "profiles": [ { "id": 4, "baseOverride": true,
    "rules": [ { "parameterType": "NATION", "calculationType": "NORMAL",    "value": 1 },
               { "parameterType": "LEAGUE", "calculationType": "UNIVERSAL", "value": 3 },
               { "parameterType": "CLUB",   "calculationType": "UNIVERSAL", "value": 2 } ] } ],
  "mappings": [ { "profileId": 4, "rarityIds": [69] } ] }
```

Plus `teamChemLinks`, which maps linked clubs (e.g. men's/women's sides of the same club) so "same club" counts across them. This is implementable as pure functions in a few hundred lines.

### 1.6 Applying a solution

The web app applies a squad with `PUT /ut/game/fc27/squad/{id}` (1.7 KB body) — captured in the recon. Squad shape: `{ id, formation, rating, chemistry, players: [ { index, itemData, chemistry, loyaltyBonus } ], managerId, squadType, ... }`.

### 1.7 Reader interfaces for the club search (#70)

Two interface facts about EA's club read were established while chasing why the
`fsl-build/8` live run read 0 club items. Both are contracts, not preferences.

- **The search criteria must be handed to EA as the live object, never as a
  copy.** A `UTBucketedItemSearchViewModel` criteria is a class instance whose
  public fields (`type`, `category`, `position`, …) live on the prototype,
  backed by own `_`-prefixed fields. Spreading it into a plain object keeps only
  the own backing fields, so EA's own search threw
  `Cannot read properties of undefined (reading 'toLowerCase')` on the missing
  `type`. The reference takes the criteria object itself, sets `untradeables`,
  `count` and `offset` on it, and passes that same object to
  `services.Club.search`. This project constructs **its own**
  `new UTBucketedItemSearchViewModel()` and reads `searchCriteria` from that
  instance, so EA's live club-UI criteria are never mutated. When the class is
  unavailable, the criteria resolved from the live page are used instead, and
  the fields this project set are restored after the read — on success, failure
  and timeout alike — so a solve never leaves EA's own club search with this
  project's page size.
- **EA's observable is subscribed as `observe(subscriber, callback)`.** The
  first argument is a subscriber object the caller owns; the callback receives
  `(observer, event)`, where the observer releases the subscription with
  `observer.unobserve(subscriber)`, and the event carries
  `{ data, error, response, status, success }` with the payload as
  `response ?? data`. Calling `observe(callback)` with one argument never fires
  and burns the whole 5 s timeout — the `fsl-build/8` log's
  `observeOnce: … timed out after 5000ms` — even though the returned value was a
  real EA observable (`observe=function, unobserve=function`). A silent
  single-argument retry must not be added: a wrong subscription has to fail
  loudly.

Both facts are what `fsl-build/9` implements (#70). Do not "tidy" the criteria
back into a copy or reintroduce a one-argument subscription: either change
reintroduces the defect it fixed. The `fsl-build/9` live run is the confirmation
that EA accepts the object and fires the callback.

### 1.8 Live reader facts from `fsl-build/9` (#72)

The `fsl-build/9` live run proved both readers were looking at the wrong part
of EA's answer. Two payload facts were established from what EA returned, in
our own words:

- **The club payload's item array is `items`.** `services.Club.search` returned
  `{ items, retrievedAll }` and `services.Item.searchStorageItems` returned
  `{ items, endOfList }`. The earlier `/club` recon named the same array
  `itemData`; the live payload wins. A page walk is finished when `endOfList`
  is present and true, otherwise when `retrievedAll` is true; a page carrying
  neither flag keeps the walk going until an empty page or the page cap. The
  offset advances by the requested page size (`criteria.count`), never by the
  number of items a page happened to return, because EA may clamp or trim a
  page. `itemData` stays named in diagnostics when a payload carries it
  instead, but it is never read as a fallback.
- **The challenge comes from the SBC set API, not the panel argument.** The
  live panel hook (`initWithSBCSet`) carried no requirements in any of the
  seven shapes the read probed. The verified path is
  `services.SBC.requestSets()` → a `sets` array → for each set
  `services.SBC.requestChallengesForSet(set)` → `set.getChallenges()`, a method
  call on the set entity. A challenge entity carries `id`, `name`/`title`,
  `isCompleted()`, `isInProgress()` and `squad`. A challenge is usable when
  `isCompleted()` is falsy, and a throwing `isCompleted()` counts as open. With
  several open, an in-progress one is preferred, otherwise the first. It is
  loaded with `services.SBC.sbcDAO.loadChallenge(id, inProgress)` when that
  method exists and the entity has an id, otherwise with
  `services.SBC.loadChallenge(entity)` — the entity object itself, never an id.
  Requirements are read out of the loaded payload, and the loaded `squad` is
  written back onto the entity when the entity has none. The panel-argument
  path stays as a reported fallback. Both calls return observables and are
  subscribed exactly as section 1.7 describes.

These are the facts `fsl-build/10` implements. A later live probe that
contradicts either one wins over this section.

---

## 2. Design decisions

### 2.1 Own codebase, AutoPilot-SBC as reference only

Per your call: we do **not** fork. We read AutoPilot-SBC for the technique (how it hooks EA's views, what it sends, how it structures the solver) and then write our own implementation. Consequences:

- Our repo can be licensed as we like (**MIT recommended**) — no GPL obligations inherited.
- **We must not copy code.** Reading for *approach* is fine; lifting functions is not. Any helper we consciously mirror gets rewritten from the spec above, not transcribed.
- Practical consequence for the solver: AutoPilot-SBC uses `glpk.js` (WASM, **GPL-3.0**). Pulling that in would force our public repo to GPL-3.0. See §2.3.

### 2.2 Single-challenge solve in v1

Scope is locked to: pick one challenge → solve → show → user applies. No multi-solve, no set-solve, no sequences. Those are v2 and the architecture keeps the door open (the solver core takes a normalised `{ challenge, pool }` and returns a solution — nothing single-challenge-specific).

### 2.3 Solver approach: own heuristic core, no GPL dependency

Two ways this could be built, in plain terms:

**ILP (integer linear programming)** — you write the problem as a set of mathematical equations ("minimise cost, subject to: 11 players, ≥ 30 chemistry, ≥ 3 leagues, …") and hand them to a solver library, which returns a *provably optimal* answer. Powerful, but: the constraints must be expressible as linear equations, and **chemistry is not** — it depends on which players sit next to each other, which is a pairwise/non-linear relationship. So even with ILP you would have to iterate around chemistry anyway. On top of that: a heavy WASM solver dependency (~400 KB), slower to build and debug, and when it fails you get a bare "infeasible" with little intuition. The good libraries are GPL-3.0, which would infect an MIT repo.

**Heuristic** — we write our own search: build a solid squad greedily, then repeatedly try swapping players in and out until nothing improves. *Not* provably optimal, but: fast, tiny, zero dependencies, always returns something usable rather than failing outright, and it is explainable — which is the point for a showcase repo.

**Decision: heuristic.** The reasoning, in order of weight:

1. Chemistry breaks linearity regardless, so ILP buys less than it appears to.
2. Fodder cost is dominated by a handful of high-rated players; a good swap-search lands within a few percent of optimal in practice.
3. Zero dependencies keeps the repo MIT and 100% own work.
4. It is the better portfolio piece — you can explain your own algorithm end to end.

Fallback if quality disappoints: add a small exact branch-and-bound over the reduced candidate pool, still own code.

### 2.4 Fodder-price guard

Two-tier pricing, both sources already available:

1. **Primary:** fut.gg player-prices API (`/api/fut/player-prices/26/` → FC27 path), batched, cached, rate-limited, fetched from the service worker.
2. **Fallback / offline:** EA's own `marketAverage` and `discardValue`, which are *already inside every club item payload*. Zero extra requests, always present.

Pricing weights (tunable in settings). The four numbers are a **borrowed published
heuristic** — the percentages SBC Monkey describes in its public documentation for how it
values fodder. That is a published fact about a third party we are not affiliated with; the
numbers are not claimed to be tuned or correct, and the settings sliders keep them
configurable:
- untradeable duplicate → 0.1 × value (prefer clearing duplicates)
- untradeable → 0.7 × value
- tradeable → 1.0 × value
- concept player → 2.0 × value (must be bought, so avoid)

A card with no value from any source is estimated at the 60th percentile (P60) of the
market values of same-rated cards in the same club batch, tagged with its own price source;
too few same-rated values leaves it unknown. See `src/solver/prices.js`.

### 2.5 Safety posture

- **No auto-submit in v1.** We fill the squad; you press Exchange. Keeps a human in the loop, which is both safer for your account and matches your call.
- **No credentials ever touched.** We read the existing session from the page context; we never store or transmit login data.
- **Rate limiting** on all our own requests, with a visible "gentle mode" toggle.
- README states plainly that this is an unofficial tool and that automation carries account risk.

### 2.6 Concept players and per-slot alternatives

Two related features, both confirmed as in scope.

**Concept players in the pool.** A concept player is a card the solver may place that you do not own — you buy it from the market. They are valuable because they solve a challenge that your club cannot satisfy on its own, and they tell you *exactly which player to go and buy*. Consequences:

- Concept cards have no `marketAverage` from EA (you do not own them), so they must be priced from fut.gg. AutoPilot-SBC falls back to fut.gg "cheap prices" for the same reason.
- They carry a cost multiplier (proposed 2.0×, see §2.4) reflecting the manual buying effort.
- Concept usage must be **surfaced loudly in the UI**, not buried: anything the solver wants you to buy gets its own section with player name, rating, position, suggested price and a market link.
- A toggle controls whether concepts are allowed at all, and an optional cap ("at most N purchases") — because "solve it, but only with what I own" and "tell me the cheapest player to buy" are genuinely different requests.

**Per-slot alternatives (the "swap this one out" feature).** After a solve, you may disagree with one pick — wrong position, a player you want to keep for another SBC, or you simply want options. So:

- The solution is presented as 11 slots, each showing the chosen player, their rating, their cost, and **ranked alternatives** — the next-best candidates for that slot that keep the squad valid.
- Clicking an alternative swaps it in, re-validates the constraints and chemistry **instantly**, and re-runs local search on the remaining slots so the rest of the squad re-optimises around your choice.
- This is not a separate solver — it is the same local-search engine exposed interactively. Design consequence: `solve.js` must expose a pure `reevaluate(squad, lockedSlots)` entry point from day one, with "what the user locked" as an input. Retrofitting this later would mean rewriting the solver, so it is designed in now.
- Locked slots are visually marked and survive re-solves, so you can pin the players you care about and let the solver work around them.

---

## 3. Repository layout

```
fc27-sbc-solver/
├─ manifest.json                 MV3 manifest
├─ src/
│  ├─ page-bridge.js             MAIN world — hooks EA objects, injects Solve button
│  ├─ content.js                 ISOLATED world — relay between page and extension
│  ├─ background.js              service worker — fut.gg price fetch + cache
│  ├─ ea/
│  │  ├─ adapter.js              THE ONLY file that knows EA class/API names
│  │  ├─ challenge-reader.js     normalise challenge payload
│  │  ├─ club-reader.js          normalise club items
│  │  └─ squad-writer.js         write solution back into the challenge squad
│  ├─ solver/
│  │  ├─ requirements.js         elgReq[] -> normalised constraint set
│  │  ├─ chemistry.js            link/chem computation from /chemistry/profiles
│  │  ├─ candidates.js           club -> trimmed candidate pool
│  │  ├─ prices.js               cost model + price source merge
│  │  ├─ validate.js             replicate EA's eligibility checks
│  │  ├─ solve.js                greedy seed + local search
│  │  └─ worker.js               Web Worker entry
│  └─ ui/
│     ├─ panel.js                in-page button + solution preview
│     ├─ options.html/.js        settings
│     └─ styles.css
├─ test/
│  ├─ fixtures/                  sanitised recon payloads
│  └─ *.test.js
├─ README.md
└─ package.json                  vitest only, devDependency
```

**Isolation rule:** all EA-specific naming lives in `src/ea/adapter.js`. When EA renames something (as they did between FC26 and FC27 — `UTSBCSquadDetailPanelView` → `UTSBCSquadDetailPanelViewController`), exactly one file changes.

### UI surfaces — and what is actually worth designing

There is **less UI here than it sounds**, and it is worth being precise about it before spending design effort:

| Surface | Size | Where it lives | Design effort |
|---|---|---|---|
| Solve button + status | 1 button, a few states | Injected into EA's own SBC page | Small — must feel like it belongs in EA's dark UI |
| Solution preview panel | ~11 slot rows + alternatives popover | Injected alongside, or in the extension popup | **The main design surface** |
| "Buy these" concept section | list of 1–3 items | Inside the preview panel | Small — reuses the slot row |
| Options page | ~8–10 settings, 2–3 price sliders | Extension page | Medium |
| Logo / store icon | 16/32/48/128 px | Store listing, README | Small, one-off |
| README hero screenshot | 1 image | GitHub | Derived from the preview panel |

The preview panel is the only place where design genuinely matters, because it is (a) the thing you use every solve, (b) the thing you will screenshot for a public repo, and (c) the hardest constraint — it must sit inside EA's page, coexist with their layout and dark theme, and stay readable at narrow widths.

**Recommendation on OpenDesign:** do **one** focused design pass, and scope it to three deliverables — the solution preview panel (including the alternatives popover and the concept-player section), the options page, and the logo/icons. Skip it for the injected button (too small and too constrained by EA's DOM to be worth a design round). One brief, not several.

Being honest about the alternative: for a v1 that ships, competent hand-written CSS in EA's visual language would be enough. OpenDesign is worth it here precisely because this is a **public showcase repo** — the panel is what people see in the README, and a polished one is the difference between "yet another SBC script" and "a project someone bookmarked". That is your call to make; both routes are defensible.

---

## 4. Milestones

### M0 — Scaffold, fixtures, name
- Create public repo `squad-lab`, MIT LICENSE, `package.json`, vitest, `.gitignore`.
- Sanitise the recon JSON into `test/fixtures/` (strip persona id `208426089`, club identifiers, anything account-identifying).
- **Exit:** `npm test` runs, fixtures load, no personal data in the repo.

### M1 — Prove the hook (no solving)
- `page-bridge.js` detects the SBC detail panel and adds a "Solve" button.
- Clicking it reads the challenge + club and prints a normalised summary to the console.
- **Exit:** a real club count and a real `elgReq` list appear in the console on a live challenge.

### M2 — Requirement decoder + validator
- `requirements.js`: map `eligibilityKey` → normalised constraint (`MIN_CHEM`, `MIN_RATING`, `SAME_LEAGUE_MIN`, `NATION_COUNT`, …). Build the key table by reading the live `SBCEligibilityKey` enum at runtime rather than hardcoding numbers.
- `validate.js`: given a candidate 11, return pass/fail per constraint.
- **Exit:** unit tests over the captured challenge payloads; validator agrees with the challenge's own description strings.

### M3 — Chemistry engine
- Implement `chemistry.js` from `/chemistry/profiles` + `/chemistry/teamlinks`.
- **Exit:** for a squad we build, our computed chemistry equals the number EA displays in `UTSBCSquadStatsView`. This is the acceptance test.

### M4 — Pricing
- fut.gg client in the service worker: batching, caching, backoff, offline fallback to `marketAverage`, and a concept-card pricing path (§2.6).
- **Exit:** a solve produces a total fodder cost, and the same solve works with the network disabled.

### M5 — Solver v1
- `candidates.js` trim: keep the cheapest N per (slot, rating band) — keeps the search space sane.
- `solve.js`: greedy seed over constraint slots → swap-based local search (1-for-1, then 2-for-1) scoring on cost with a hard validity gate.
- `solve.js` exposes **both** `solve(challenge, pool, options)` and `reevaluate(squad, lockedSlots, pool)` — the second is what M7 needs, and it must exist from the start (§2.6).
- **Exit:** produces a valid squad for every captured challenge, under a time budget, in a Web Worker.

### M6 — Apply
- `squad-writer.js` writes the solution into the challenge squad so EA's own UI renders it.
- **Exit:** a solved squad displays correctly in the web app and you can submit it manually.

### M7 — Interactive alternatives
- Slot list with ranked alternatives per slot; click to swap; lock/unlock slots; instant re-validation and re-optimisation around locked players.
- Concept-player "buy these" section with names, ratings, prices and market links.
- **Exit:** swapping any slot re-solves in well under a second and never produces an invalid squad.

### M8 — Design pass, polish and publish
- One OpenDesign brief covering the preview panel, options page and logo/icons (see §3).
- Error states, empty-club and no-valid-solution handling, README with hero screenshot and a clear risk note.
- **Exit:** public repo is presentable and a friend can install it from the README.

---

## 5. Testing strategy

- **Solver core is pure** — no DOM, no chrome APIs. Vitest covers it directly.
- **Fixtures are real** — every challenge shape in `test/fixtures` came from the live FC27 web app, not hand-written.
- **Golden acceptance test in M3/M6:** compare our computed rating and chemistry against what EA itself displays. If our validation says "valid" and EA rejects the submission, that is a bug in our rule model, and this test catches it.
- **Manual test matrix:** fresh club (low fodder, like your current account), mid club, club with duplicates in storage, untradeable-heavy club, concept-player-required challenge.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| EA renames classes/endpoints | Solver stops working | Single adapter file; pin nothing, resolve names at runtime |
| Chemistry model mis-implemented | Solutions rejected on submit | Golden test vs EA's displayed value (M3) |
| EA ToS / account action | Account risk | No auto-submit in v1, rate limiting, explicit README warning |
| fut.gg rate limits or blocks | Prices unavailable | EA `marketAverage` fallback, caching, backoff |
| Club too small to test meaningfully | Weak verification | Test with concept players / wait for fodder; matrix in §5 |
| Scope creep into multi-solve | v1 never ships | Locked scope (§2.2); architecture keeps the door open |

---

## 7. Decisions and remaining questions

### Decided

1. **Product name:** FUT Squad Lab, published as "FUT Squad Lab | FC27 SBC Solver". Repo `fut-squad-lab`.
2. **License:** MIT. No GPL dependency, so no license inheritance.
3. **Solver:** own heuristic (greedy seed + swap-based local search), no external solver library.
4. **Concept players:** allowed, with a toggle and an optional purchase cap. Surfaced prominently with the specific player to buy.
5. **Per-slot alternatives:** in scope — ranked alternatives per slot, click to swap, lockable slots, instant re-solve. Shapes the solver API from M5 onward.
6. **Scope:** single challenge per solve. No multi-solve / set-solve / sequences in v1.
7. **No auto-submit.** The extension fills the squad; the user submits.
8. **Distribution:** public GitHub repo, shown to friends.
9. **Source:** own codebase; AutoPilot-SBC is read for technique only, never copied.

### Still open

1. **OpenDesign for the UI?** §3 lays out the surfaces. Recommendation: one brief for the preview panel + options page + logo. The alternative — hand-written CSS in EA's visual language — is defensible if you would rather keep the design work in the code. Needs a yes/no before M8.
2. **Development approach.** Local work here, or dispatch the milestones through the usual OpenCode pipeline (`/oc-issue` with `z-ai/glm-5.3-flash`, independent QA on `deepseek/deepseek-v4-flash-0731`, one GitHub issue per milestone)? Given M0–M8 are already bite-sized and independently verifiable, the pipeline fits well — but the page-bridge milestones (M1, M6) need a logged-in EA session to verify, which only you can do. That is worth splitting: delegate the pure solver core (M2–M5, M7), keep the browser-coupled work local.
