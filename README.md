# FUT Squad Lab

A free, open-source Chrome extension that solves EA SPORTS FC 27 Ultimate Team
**Squad Building Challenges (SBCs)** using your own club — one challenge at a time.

Everything runs locally in your browser. No backend, no account, no subscription,
no telemetry.

> **Status: early development.** The solver core is being built. See
> [`docs/PLAN.md`](docs/PLAN.md) for the full plan and current progress.

---

## What it does

- Solves a single SBC challenge from the players already in your club
- Minimises fodder cost, weighting untradeable duplicates so they get used first
- Shows **per-slot alternatives** — swap any single player for a ranked alternative
  and let the squad re-optimise around your choice
- Can include **concept players**, so it can tell you exactly which card to buy when
  your club cannot satisfy a challenge on its own
- Lets you **lock** players you want to keep and solve around them

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

See [`AGENTS.md`](AGENTS.md) for repository conventions and
[`docs/PLAN.md`](docs/PLAN.md) for the design and milestones.

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
