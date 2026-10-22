# Test fixtures

Real payloads captured from the **live EA SPORTS FC 27 Ultimate Team Web App** on
2026-09-17, then sanitised. They are the ground truth for the requirement model,
the item format and the chemistry rule set — the solver core is tested against
these, not against hand-written guesses.

## Files

| File | Source endpoint | What it pins down |
|---|---|---|
| `sbs-sets.json` | `GET /sbs/sets` | Set and category structure, repeatability, rewards |
| `sbs-set-10-challenges.json` | `GET /sbs/setId/10/challenges` | The `elgReq[]` requirement model |
| `sbs-set-16-challenges.json` | `GET /sbs/setId/16/challenges` | A second challenge set, for variety |
| `sbs-challenge-25-squad.json` | `POST /sbs/challenge/25` | The empty squad template a solution is written into |
| `club-items.json` | `POST /club` | The club item format, **wire layer** (`items` envelope, issue #72) |
| `club-items-observable.json` | `POST /club`, via EA's observable | The club item format, **observable layer** (issue #115) |
| `club-search-request.json` | `POST /club` (request body) | EA's own whole-club search criteria: field names, values and page size (issue #76) |
| `chemistry-profiles.json` | `GET /chemistry/profiles` | FC27 chemistry rules |
| `chemistry-teamlinks.json` | `GET /chemistry/teamlinks` | Linked clubs (cross-team club counting) |
| `chemistry-observed-squad.json` | `GET /squad/active` (derived) | **EA's own chemistry numbers** for a real squad — the only ground truth we have for the scoring layer |

`eligibility-observation.js` is not a payload capture: it is the observation table
derived from the `elgReq[]` payloads above — the `eligibilityKey` numbers, the
descriptor each key decodes to, and the inferred `eligibilityValue` scope mapping.
Issue #16 removed it from `src/` so that the solver core cannot fall back to it;
production must read the numbers from EA's live `SBCEligibilityKey` enum instead.
`test/helpers/eligibility.js` is the one place tests re-supply it.

`club-search-request.json` is the request half of the same `/club` call whose
sanitised response is `club-items.json`: the body EA's own UI sent, plus the
endpoint path and the capture timestamp. It came from the network capture quoted
in issue #76 (the `POST /ut/game/fc27/club` entry). It carries **no personal
data** — the body holds only the eight criteria fields shown (`count`, `ovrMax`,
`ovrMin`, `searchAltPositions`, `sort`, `sortBy`, `start`, `type`), all
request-shaping numbers, strings and booleans; there is no persona id, no
account field and no item in it. The whole-club criteria in
`src/ea/adapter.js` are pinned to this file by a test, so a drift between the
capture and the code fails loudly.

## Sanitisation

Before committing, every payload was stripped of anything account-specific:

- **Account endpoints were dropped entirely** — account info, user mass info,
  message templates, play stats, storage piles, active squad, transfer pile. They
  are not needed for the solver and carry the most personal data.
- **The persona ID was removed** from every URL and query string.
- **Item instance IDs were pseudonymised** with a stable SHA-256-derived
  replacement, so uniqueness and joins still work but the original values cannot
  be recovered.
- **The EA UTAS hostname was replaced** with a placeholder.
- A scan for persona IDs, email addresses, name fragments and hostnames was run
  over the output and passed clean.

Card `assetId` values were deliberately **kept**. They identify card definitions in
public game data, not anything belonging to an account, and the solver needs them
to resolve which card a slot refers to.

### The one exception: `chemistry-observed-squad.json`

Account endpoints were dropped raw, including the active squad. One **derived** form of the
active squad is committed anyway, because it carries something nothing else does: EA's own
chemistry numbers, per player and as a squad total. Those cannot be obtained any other way,
and without them the scoring layer has nothing to be checked against.

What was done to it, beyond the normal pass:

- reduced to the fields the chemistry computation needs — `rating`, `nation`, `leagueId`,
  `teamid`, `preferredPosition`, `possiblePositions`, `rareflag`, `cardsubtypeid`
- the persona ID, squad name, squad ID, manager, tactics, kickers and all club vanity items
  (badges, kits, stadium, tifo, ball, celebrations) were removed
- item instance IDs were replaced with positional placeholders (`item-000` … ), not hashed:
  nothing in this fixture needs to join against the club listing, so there is no reason to
  keep a recoverable identifier at all

EA's chemistry numbers were kept **unmodified** — they are the entire point of the file. A
scan for the persona ID, the squad name, `personaId`, `squadName` and `managerId` over the
committed file returns nothing.

### The one other shape: `club-items-observable.json`

EA's `POST /club` reaches this project twice. The body on the wire names its
items `itemData[]` with `assetId`, `rating`, `nation`, `teamid`, `rareflag` and
`marketAverage`; that is `club-items.json`. What EA's **observable** hands the
read layer is its own entity model, with different names for the same facts:
`definitionId`, `_rating`, `_staticData`, `_metaData`, `teamId`, `nationId`,
`subtype`, `basePossiblePositions`, `_rareflag`, `_basePlusRoles`, `tradable`,
`utasPile`. That is `club-items-observable.json`, and the `fsl-build/14` run
failed every item on it.

It is a **shape** fixture, not a capture. Every key name on it was reported by
the live page's own diagnostics; every value is invented, small and free of
personal data, real card definitions and account fields. The item's own
`definitionId` and the `_staticData` key `assetId` are the exception that proves
the rule: the file carries both, the reader reads `_staticData.assetId` and
refuses an item without it, and it reports `_staticData`'s own key names either
way. A `definitionId` is never read as an asset id — the two are different
concepts that would only agree by coincidence — so a fixture may be
hypothetical, the reader may not.

The `fsl-build/15` live run then proved the fixture was the wrong shape in one
more place: the live observable item carries `preferredPosition` as a **number**,
not a string, so the reader rejected the first item of the first page and the
club read yielded nothing. The fixture now says so — `preferredPosition` is a
number, the string vocabulary sits on `basePossiblePositions`, and `_staticData`
carries the sixteen key names the capture reported (`assetId`, `assetType`,
`assetYear`, `amount`, `name`, `firstName`, `lastName`, `knownAs`,
`description`, `manufacturer`, `trainedAttribute`, `trainPosFrom`,
`trainPosTo`, `goldBoost`, `silverBoost`, `bronzeBoost`).

Two things about that file stay invented on purpose. The **names and the types**
of those sixteen keys are the capture's own — `fsl-build/15` reported both, off
`club.itemLayer.subLayers._staticData.keys` — so only the **values** are
synthetic, and the adapter reads none of them but `assetId`. The `empty` flag
in that key table is a third attribute, not a type: it is derived from the
value it describes, so on this fixture it follows the synthetic value
(`assetType: ""` reads as `empty: true`) and says nothing about EA's own
emptiness. The **number** in
`preferredPosition` is opaque: no capture proves which code means which
position, so the reader refuses it and never decodes it. Only
`basePossiblePositions` carries a position vocabulary on this fixture, which is
exactly the one place the reader reads it from.

## Rules for adding fixtures

- Never commit a raw capture. Sanitise first, and re-run the scan.
- `*.har`, `*.crx` and `*-recon*.json` are gitignored — do not force-add them.
- If a new fixture pins down a new payload shape, add a row to the table above.
- Regenerating these requires a logged-in FC27 web app session. Document what
  changed in the commit message, because a fixture change often means EA changed
  something and the solver needs to follow.
