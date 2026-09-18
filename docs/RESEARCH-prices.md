# Price sources for EA SPORTS FC 27 — research

Date: 2026-09-18. This document records what we verified about obtaining card
prices, so that the price layer is built on facts rather than on a guess. It
supersedes the fut.gg assumption in issue #10.

## Summary

The club item payload already carries **EA's own market price** for every card
the user owns (`marketAverage`). That is a genuine market price — EA's own UI
renders it as "market average" — and it is already wired through
`src/solver/prices.js`. No third party is needed for the common case.

There is **no reachable, legitimate, automated source of current market prices
for cards the user does not own.** fut.gg's price routes are behind a deliberate
Cloudflare JS challenge; FUTBIN, FUTWIZ and FUTNext return HTTP 403 to all
programmatic access; EA's FC Community API is limited to three approved partner
sites. This is access protection by intent, and this project does not circumvent
it.

## 1. EA's own price data — available, already in use

Every club item carries:

| Field            | Meaning                                    | Notes                              |
| ---------------- | ------------------------------------------ | ---------------------------------- |
| `marketAverage`  | EA's market average for the card            | `-1` when absent                   |
| `discardValue`   | Quick-sell value                            |                                    |
| `marketDataMinPrice` / `marketDataMaxPrice` | EA's allowed listing band    | a band, not a price                |
| `lastSalePrice`  | the user's own last sale (usually unset)    |                                    |

Verified in the FC27 web app bundle (`compiled_2.js`):

```js
i._marketAverage = t?.marketAverage ?? -1;
UTItemEntity.prototype.getMarketAverage = function () { return this._marketAverage; };
```

and the item view renders it as a labelled market row, gated behind the server
flag `MARKET_AVERAGE_ENABLED`:

```js
services.Configuration.checkFeatureEnabled(
  UTServerSettingsRepository.KEY.MARKET_AVERAGE_ENABLED
) && this.setMarketAvg(t.getMarketAverage());
```

Because it is a server-side feature flag, `MARKET_AVERAGE_ENABLED` can be off for
a user, in which case the value is not rendered. We must therefore treat a
missing average as unknown, never as zero.

Coverage on the sanitised fixture (`test/fixtures/club-items.json`, 42 cards):
`marketAverage` 37/42, `discardValue` 9/42, `untradableDiscardValue` 42/42.
`marketDataMinPrice`/`marketDataMaxPrice` are constant 600/10000 there, i.e.
defaults rather than resolved values — consistent with the decision already
recorded in `prices.js` not to use them as prices.

## 2. EA's batched price-limit endpoints — verified to exist

Both are built by `UTTransfersDAO` in the FC27 web app bundle:

```
GET /ut/game/fc27/marketdata/pricelimits?defId=<comma separated>
GET /ut/game/fc27/marketdata/item/pricelimits?itemIdList=<comma separated>
```

Both accept a **comma-separated batch** and the response is a bare array:

```js
r.response = { marketData: e.response.map(function (t) {
  return { defId: t.defId, itemId: t.itemId,
           priceLimits: new UTValueBandVO(t.minPrice, t.maxPrice) };
}) };
```

So each row is `{ defId, itemId, minPrice, maxPrice }`, with `defId` addressing a
card definition and `itemId` a specific owned item. An empty input list is
short-circuited client-side to `{ marketData: [] }`.

Existence verified against the live API host
(`utas.mob.v1.prd.futc-ext.gcp.ea.com`) with a control:

| Request                                | Status | Reading                    |
| -------------------------------------- | ------ | -------------------------- |
| `GET /ut/game/fc27/sbs/sets`           | 401    | route exists, needs session |
| `GET /ut/game/fc27/marketdata/pricelimits` | 403 | **route exists**, rejected |
| `GET /ut/game/fc27/marketdata/item/pricelimits` | 403 | **route exists** |
| `GET /ut/game/fc27/findes-ikke-xyz`    | 404    | route does not exist       |

These give EA's permitted listing band for a card, not its market price. They are
useful as a **bound** on realisable value — a card that can never be listed above
`maxPrice` is worth at most that — but they are not a substitute for a price.

## 3. The API host is not `www.ea.com`

All game endpoints live on:

```
https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/...
```

The web app itself is served from `www.ea.com`. Any code that needs to call the
game API directly must account for the different origin; code that goes through
the page's own session does not, because the page already holds the session.

## 4. What is not available, and why

**fut.gg price routes.** `https://www.fut.gg/api/fut/player-prices/<game>/`
returns HTTP 403 to non-browser clients. The FC27 project
[`MIKKELEFROST/fut27`](https://github.com/MIKKELEFROST/fut27) states the position
plainly in its README (Danish):

> FUT.GG's prisruter (`/api/fut/player-prices/…`) ligger bag Cloudflares
> JS-challenge, og FUTBIN, FUTWIZ og FUTNext blokerer al programmatisk adgang med
> HTTP 403. Det er bevidst adgangsbeskyttelse, og den omgår vi ikke.

Confirmed independently here: `player-prices/27/` and `player-prices/26/` both
returned 403 with a browser user-agent, while fut.gg's *open* endpoint
`api/fut/players/v2/27/` returned 200 — and carries no prices (`price: null`,
`hasPrice: false` on every row returned).

fut.gg's open definition endpoint, however, is usable for **non-price** metadata
and is genuinely open:
`https://www.fut.gg/api/fut/players/v2/27/definitions/?overall__gte=85`
(page size locked to 30, hard cap of 10 000 rows per query, so large reads must
be split into rating bands).

**FUTBIN, FUTWIZ, FUTNext**: HTTP 403 on all programmatic access.

**EA FC Community API**: gives delegated read access to Ultimate Team data via
OAuth, but only to three approved partners (FUT.GG, FUTBIN, FUTWIZ).

**How the commercial tools do it.** They crowdsource prices through their own
browser extension: the user looks prices up in the web app and the extension
reports what it saw. That is a legitimate pattern — and for us it is the same
shape as reading `marketAverage` from a club payload the user's own session
already fetched.

**No market search route exists in the FC27 web app bundle.** All 82 route
literals in `compiled_2.js` were enumerated; the market-related ones are only
`auctionhouse/relist`, `bid`, `marketdata/pricelimits`,
`marketdata/item/pricelimits`, `trade/`, `trade/status/lite` and `watchlist`.
Probes of `/search`, `/market/search`, `/transfermarket`, `/transfermarket/search`
and `/trade/search` all returned 404. The web app additionally feature-flags
market access (`KEY_HIDE_TRANSFER_MARKET`, `TRADING_ENABLED`,
`SHOWCASE_TRANSFER_MARKET_ENABLED`), so market browsing may be disabled for a
web-app user entirely.

## 5. Consequences for this project

1. **Owned cards are priced from EA's `marketAverage`.** This is the design
   contract's "Club cached values" option, it needs no network and no permission,
   and it is already implemented. It is where the accuracy of a solve's cost comes
   from in the normal case, because an SBC is solved from the club.
2. **`marketAverage` can be absent** (5/42 in the fixture, `-1` from EA). A missing
   price stays unknown — never zero. `prices.js` already enforces this.
3. **Concept cards cannot be priced automatically.** EA holds no price data for a
   card the user does not own, and no external source is reachable. An unpriced
   concept card must be reported as unknown rather than guessed at.
4. **The external price table interface in `prices.js` stays**, but nothing
   fetches it automatically. It remains the seam for a user-supplied import.
5. **`marketDataMinPrice`/`marketDataMaxPrice` may be used as a bound**, never as
   a resolved price.
6. **Do not add a `fut.gg` host permission.** It would grant access to an API that
   refuses us anyway.

## Reproducing

```bash
# fut.gg price route (expect 403)
curl -s -o /dev/null -w '%{http_code}\n' \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' \
  https://www.fut.gg/api/fut/player-prices/27/

# fut.gg open metadata route (expect 200, no prices)
curl -s -A 'Mozilla/5.0' \
  'https://www.fut.gg/api/fut/players/v2/27/definitions/?overall__gte=85' | head -c 300

# EA route existence check (401 = exists, 404 = does not)
curl -s -o /dev/null -w '%{http_code}\n' \
  https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/sbs/sets
```

Web app bundle (contains the endpoint literals):

```bash
B=https://www.ea.com/ea-sports-fc/ultimate-team/web-app
curl -s "$B/js/compiled_2.js" | grep -o '"/[a-zA-Z0-9/_-]*"' | sort -u
```
