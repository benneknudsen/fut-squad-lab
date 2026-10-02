# FUT Squad Lab

A free, open-source Chrome extension that solves EA SPORTS FC 27 Ultimate Team
**Squad Building Challenges (SBCs)** using your own club — one challenge at a time.

Everything runs locally in your browser. No backend, no account, no subscription,
no telemetry.

> **Status: alpha.** The engine is built and green — 51 test files, 1179 tests,
> against real payload fixtures captured from the live FC27 web app. What is
> **not** done yet is the solution panel with per-slot alternatives (issue #14)
> and the last README/docs pass (issue #15). Live browser verification is done
> by hand, against your own club.
>
> Milestones M0–M6 are complete; M7 and M8 are not. See
> [`docs/PLAN.md`](docs/PLAN.md) for the full plan and the current state.

---

## What it does

Built and tested today:

- Reads the challenge's own requirements and your club straight from the page,
  using EA's own service objects — no scraping, no guesswork
- Solves a single SBC challenge from the players already in your club
- Minimises fodder cost, weighting untradeable duplicates so they get used first
- Validates the solution against EA's rating, chemistry and scope rules before it
  ever touches the squad
- Writes the solved squad into EA's own panel, so you review it where you already work

Landing with M7/M8 (issues [#14](https://github.com/benneknudsen/fut-squad-lab/issues/14)
and [#15](https://github.com/benneknudsen/fut-squad-lab/issues/15)):

- A solution panel with **per-slot alternatives** — swap any single player for a
  ranked alternative and let the squad re-optimise around your choice
- **Locking** players you want to keep, and solving around them
- **Concept players**, so it can tell you exactly which card to buy when your club
  cannot satisfy a challenge on its own

## What it does not do

- It does not submit anything for you. It fills the squad; **you** press Exchange.
- It does not access, store or transmit your EA credentials.
- It does not talk to any server of ours. There is no server.

## Install (development)

Not yet on the Chrome Web Store. To run it from source:

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repository folder
5. Open the EA SPORTS FC Ultimate Team Web App and reload the page

## Development

```bash
npm test -- --run --reporter=dot    # unit tests
```

No build step. The extension is plain ES modules and ships as static files.
51 test files, 1179 tests, all green — run against sanitised payloads captured
from the live FC27 web app rather than hand-written fixtures.

See [`AGENTS.md`](AGENTS.md) for repository conventions and
[`docs/PLAN.md`](docs/PLAN.md) for the design and milestones. Issues are one
milestone-sized piece of work each, and the closed ones are the honest record of
what has been verified.

---

## Disclaimer

This is an **unofficial** tool. It is not affiliated with, endorsed by, or
sponsored by Electronic Arts. EA SPORTS FC and all related marks and assets are
property of Electronic Arts Inc. No EA-owned logos, crests, badges or other
assets are included in this repository.

Automating the FC Web App may be contrary to EA's Terms of Service and could
result in action against your account. You use this software at your own risk.
The extension deliberately does not auto-submit challenges, so that a human
remains in the loop.

## License

MIT — see [LICENSE](LICENSE).
