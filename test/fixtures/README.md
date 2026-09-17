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
| `club-items.json` | `POST /club` | The club item format |
| `chemistry-profiles.json` | `GET /chemistry/profiles` | FC27 chemistry rules |
| `chemistry-teamlinks.json` | `GET /chemistry/teamlinks` | Linked clubs (cross-team club counting) |

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

## Rules for adding fixtures

- Never commit a raw capture. Sanitise first, and re-run the scan.
- `*.har`, `*.crx` and `*-recon*.json` are gitignored — do not force-add them.
- If a new fixture pins down a new payload shape, add a row to the table above.
- Regenerating these requires a logged-in FC27 web app session. Document what
  changed in the commit message, because a fixture change often means EA changed
  something and the solver needs to follow.
