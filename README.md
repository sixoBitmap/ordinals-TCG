# ORDINAL CARDS

1v1 top-trumps with ordinal inscriptions as cards. Zero dependencies.

## Run

```
node server.js
```

→ http://localhost:8741

## Test locally with two players

Open two browser windows (or one normal + one incognito, or two different
browsers). In each: connect a wallet (XVERSE / UNISAT) or paste any address
holding inscriptions (ADDRESS), pick 3–20 cards, PLAY. Both enter the
matchmaking queue and get paired.

Player identity is per-tab (sessionStorage), so two tabs of the same browser
also work as two players.

## Rules

- Deck: 3–20 inscriptions you pick from the connected wallet.
- Rounds: the smaller deck's size (5-card deck vs 20-card deck → 5 rounds).
- Hand of 3; draw 1 from your shuffled pile after every round.
- Leaders alternate. The leader plays a card face-down and calls a field
  (FEE, BLK=height, NUM=inscription number, SIZE=content bytes, VAL=postage
  sats) and a direction (▲ highest wins / ▼ lowest wins). The follower sees
  the call and answers with a card. Reveal — the better value takes the round.
- Most round wins takes the match. 60s per move, then a random legal move is
  auto-played. Leaving forfeits.
- A deck whose card metadata can't be fully fetched at match start is rejected
  ("DECK FAILED"); the opponent goes straight back into the queue.

## Deploy (to play with others)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sixoBitmap/ordinals-TCG)

One click via the included `render.yaml` (free plan): it starts
`node server.js` with `ORD_GATEWAY=https://ord.xverse.app` — needed because
ordinals.com rate-limits/blocks datacenter IPs like Render's. Free instances
sleep when idle (first visit takes ~1 min to wake), and matches live in
memory, so a restart clears any game in progress.

Any other Node ≥18 host works the same way — `node server.js`, `PORT` env
respected, zero deps. Keep it a single instance: matchmaking state is
in-memory.

## Data

All card stats come from ordinals.com recursive endpoints
(`/r/inscription/{id}`), content from `/content/{id}`, both through a local
caching proxy (`/o/…`) to stay under ordinals.com rate limits.
Wallet listings come from the Xverse address API
(`api-3.xverse.app/v1/address/{addr}/ordinal-utxo`) because ordinals.com has
its non-recursive JSON API (address → inscriptions) disabled.

Ownership is trusted, not verified — for real stakes, add a
`signMessage`-based login so a player can only queue decks their wallet holds.
