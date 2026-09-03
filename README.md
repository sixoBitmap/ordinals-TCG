# ORDINAL CARDS

1v1 card game where every card is a Bitcoin ordinal inscription. Zero dependencies.
Two modes, one deck builder: **BATTLE** (Pokémon-style knockouts) and **STATS** (call a
stat, high or low). Live: https://ordinal-cards.onrender.com

## Run

```
node server.js
```

→ http://localhost:8741 — `npm test` runs the unit tests.

## Test locally with two players

Open two browser windows (or two tabs — player identity is per tab). In each: connect
a wallet (XVERSE / UNISAT) or paste any address holding inscriptions (ADDRESS), pick
3–20 cards, choose BATTLE or STATS, PLAY. Both enter that mode's matchmaking queue and
get paired.

## BATTLE mode

Every card has three combat stats derived from its on-chain data (see Data):

- **HP** ← content size · **ATK** ← sats per vbyte paid · **DEF** ← total fee paid, all 1–100
- **Type** from the content type: IMG › TXT › CODE › IMG — attacking with the advantage does ×1.5
- **Tier** from the card's best stat: LEGENDARY (99+), EPIC (95+), RARE (80+), COMMON

Rules:
- Deck 3–20. Each player starts with 4 cards (1 active + a bench of 3); the rest is the pile.
- Both pick an ACTIVE from their hand. The older inscription (lower number) moves first.
- On your turn: **ATTACK** (damage = max(5, ATK − DEF/2) × type multiplier) or **SWAP** your
  active with a bench card (damage stays on the benched card).
- HP 0 = knockout. The victim promotes a bench card (and refills the bench from the pile).
- **First to 3 knockouts wins**; a player with no cards left loses. 60 actions cap a match
  (tiebreak: knockouts → remaining HP → older active).
- 60 s per move, then a sensible move is auto-played. Leaving forfeits.

## STATS mode

- Rounds = the smaller deck's size. Hand of 3, draw 1 after every round. Leaders alternate.
- The leader plays a card face-down and calls a field — FEE, BLK (height), NUM (inscription
  number), SIZE (bytes), VAL (postage sats), CHLD (children), REINSC (reinscriptions on its
  sat) — and a direction (▲ highest wins / ▼ lowest wins). The follower answers with a card.
- Most round wins takes the match.

## Data

All card data comes from ordinals.com recursive endpoints (`/r/inscription/{id}`,
`/r/children`, `/r/sat`), content from `/content/{id}`, through a local caching proxy that
stays under ordinals.com rate limits. Wallet listings come from the Xverse address API
(`api-3.xverse.app/v1/address/{addr}/ordinal-utxo`) because ordinals.com has its
non-recursive JSON API disabled.

Battle stats (`stats.js`):
- **ATK / DEF** are percentile ranks against `scale-v1.json` — 99 breakpoints per stat from a
  stratified sample of 3,000 inscriptions across the whole number range (built once with
  `npm run build-scale`, which maps inscription numbers to ids via the ordinals.com HTML
  pages, since no free API lists inscriptions sorted by stat — Hiro's is gone).
  fee_rate ≈ fee / (bytes/4 + 180 vB).
- **HP** is a log scale of content size up to 400 KB. Rank would not work here: the
  sampled universe is mostly tiny text/JSON (median 53 bytes), so every image would rank
  p99+ and all art cards would collapse to HP 99–100.
- Caveat: `fee` is the whole reveal transaction fee, so batch-minted collection items share
  their batch's fee.

Roadmap: a "God Set" reference (top inscriptions per stat, inscribed on-chain) with a GOD
tier for members; `signMessage` ownership login.

## Deploy (to play with others)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sixoBitmap/ordinals-TCG)

One click via the included `render.yaml` (free plan): it starts `node server.js` with
`ORD_GATEWAY=https://ord.xverse.app` — needed because ordinals.com rate-limits/blocks
datacenter IPs like Render's. Free instances sleep when idle (first visit takes ~1 min to
wake), and matches live in memory, so a restart clears any game in progress.

Any other Node ≥18 host works the same way — `node server.js`, `PORT` env respected, zero
deps. Keep it a single instance: matchmaking state is in-memory. `TURN_MS` overrides the
move timer (handy for tests).

Ownership is trusted, not verified — anyone can queue decks from any address.
