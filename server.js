// ORDINAL CARDS — 1v1 top-trumps with ordinal inscriptions as cards.
// Zero-dependency local server: static files + SSE realtime + matchmaking +
// authoritative game logic + a caching proxy for ordinals.com recursive API.
//
//   node server.js          → http://localhost:8741
//
// The proxy exists because ordinals.com rate-limits aggressively (429s) and
// has no CORS on /content — every browser request goes through the in-memory
// cache here, and upstream calls are capped at 4 concurrent.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { battleStats, loadScale } from "./stats.js";
import * as battle from "./battle.js";

const PORT = Number(process.env.PORT || 8741);
const ORD = (process.env.ORD_GATEWAY || "https://ordinals.com").replace(/\/$/, "");
const XVERSE_API = (process.env.XVERSE_API || "https://api-3.xverse.app").replace(/\/$/, "");
const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT = join(APP_ROOT, "public");

// percentile scale for HP/ATK/DEF — sampled once by scripts/build-scale.mjs
const SCALE = loadScale(join(APP_ROOT, "scale-v1.json"));
console.log(`scale v${SCALE.version} (${SCALE.method}, ${SCALE.sampleSize} sampled)`);

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; ordinal-cards) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "*/*",
};

const DECK_MIN = 3, DECK_MAX = 20;
const HAND_SIZE = 3;         // STATS mode hand
const TURN_MS = Number(process.env.TURN_MS) || 60_000;   // auto-play after this so a match can never hang
const REVEAL_MS = 3200;
const GONE_MS = 25_000;      // disconnected this long mid-game → forfeit
const WALLET_MAX = 120;      // cap inscriptions listed per wallet

const FIELDS = ["fee", "height", "number", "content_length", "value", "children", "reinsc"];
const INSC_ID = /^[0-9a-f]{64}i\d+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- ord proxy

const cache = new Map(); // key → {ct, body:Buffer, exp}
let cacheBytes = 0;
const CACHE_MAX = 100 * 1024 * 1024;
const ITEM_MAX = 8 * 1024 * 1024;
const inflight = new Map(); // key → Promise<entry|null>

let active = 0;
const waiters = [];
async function slot() {
  if (active >= 4) {
    // bounded backlog — a flood of cache misses must not queue forever behind
    // the 4 upstream slots that live gameplay depends on
    if (waiters.length >= 300) throw new Error("busy");
    await new Promise((r) => waiters.push(r));
  }
  active++;
}
function freeSlot() {
  active--;
  const w = waiters.shift();
  if (w) w();
}

async function upstream(url) {
  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      return r;
    }
  } finally { freeSlot(); }
}

function cachePut(key, entry) {
  cacheBytes += entry.body.length;
  cache.set(key, entry);
  // FIFO eviction of expirable entries first, then oldest of everything
  for (const [k, e] of cache) {
    if (cacheBytes <= CACHE_MAX) break;
    cache.delete(k);
    cacheBytes -= e.body.length;
  }
}

// Definite upstream misses (404s) are remembered briefly so repeated requests
// for nonexistent ids don't burn upstream slots. Transient failures are not.
const missCache = new Map(); // path → expiry ts
const MISS_TTL = 60_000, MISS_MAX = 2000;
function noteMiss(path) {
  missCache.set(path, Date.now() + MISS_TTL);
  if (missCache.size > MISS_MAX) missCache.delete(missCache.keys().next().value);
}

// Fetch an ordinals.com path through the cache. `ttl` Infinity = immutable.
async function ordFetch(path, ttl) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit;
  const miss = missCache.get(path);
  if (miss && miss > Date.now()) return null;
  if (inflight.has(path)) return inflight.get(path);
  const p = (async () => {
    try {
      const r = await upstream(ORD + path);
      if (!r.ok) { noteMiss(path); return null; }
      const body = Buffer.from(await r.arrayBuffer());
      const entry = { ct: r.headers.get("content-type") || "application/octet-stream", body, exp: Date.now() + (ttl === Infinity ? 1e15 : ttl) };
      if (body.length <= ITEM_MAX) cachePut(path, entry);
      return entry;
    } catch { return null; }
    finally { inflight.delete(path); }
  })();
  inflight.set(path, p);
  return p;
}

// Count ids across a paged recursive endpoint (/r/children/<id>, /r/sat/<n>).
// Capped at 3 pages (300) — enough spread for a game stat, bounded upstream cost.
async function countIds(base) {
  let n = 0;
  for (let page = 0; page < 3; page++) {
    const e = await ordFetch(`${base}/${page}`, 600_000); // mutable → 10 min TTL
    if (!e) break;
    try {
      const j = JSON.parse(e.body.toString("utf8"));
      n += (j.ids || []).length;
      if (!j.more) break;
    } catch { break; }
  }
  return n;
}

// Authoritative card metadata (server trusts only this, never the client).
const cardMeta = new Map(); // id → card | null
async function getCard(id) {
  if (cardMeta.has(id)) return cardMeta.get(id);
  const e = await ordFetch(`/r/inscription/${id}`, Infinity);
  let card = null;
  if (e) {
    try {
      const m = JSON.parse(e.body.toString("utf8"));
      // mutable traits: children of the inscription, reinscriptions on its sat
      const [children, satTotal] = await Promise.all([
        countIds(`/r/children/${id}`),
        m.sat != null ? countIds(`/r/sat/${m.sat}`) : Promise.resolve(0),
      ]);
      card = {
        id: m.id,
        number: m.number ?? 0,
        fee: m.fee ?? 0,
        height: m.height ?? 0,
        content_length: m.content_length ?? 0,
        value: m.value ?? 0,
        children,
        reinsc: Math.max(0, satTotal - 1),
        content_type: m.content_type || "",
        ...battleStats(m, SCALE),   // hp/hpMax/atk/def/type/tier/pct for BATTLE mode
      };
    } catch { /* not json → null */ }
  }
  if (card) cardMeta.set(id, card);
  return card;
}

// -------------------------------------------------------------- wallet list

const addrCache = new Map(); // addr → {list, exp}
async function addrInscriptions(addr) {
  const hit = addrCache.get(addr);
  if (hit && hit.exp > Date.now()) return hit.list;
  const list = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    // only a first-page failure is fatal — a late page dropping out under rate
    // limits should degrade to a shorter listing, not a "WALLET FAILED"
    let j = null;
    try {
      const r = await upstream(`${XVERSE_API}/v1/address/${encodeURIComponent(addr)}/ordinal-utxo?limit=60&offset=${offset}`);
      if (r.ok) j = await r.json();
      else if (page === 0) throw new Error(`wallet api ${r.status}`);
    } catch (e) { if (page === 0) throw e; }
    if (!j) break;
    const utxos = j.results || [];
    for (const u of utxos)
      for (const insc of (u.inscriptions || []))
        if (INSC_ID.test(insc.id)) list.push({ id: insc.id, content_type: insc.content_type || "" });
    offset += (j.limit ?? utxos.length) || 60;
    if (!utxos.length || offset >= (j.total ?? 0) || list.length >= WALLET_MAX) break;
  }
  const out = list.slice(0, WALLET_MAX);
  addrCache.set(addr, { list: out, exp: Date.now() + 60_000 });
  return out;
}

// ------------------------------------------------------------ players/games

const players = new Map(); // pid → {pid, name, streams, lastSeen, gameId, inQueue, mode, deckIds}
const queues = { battle: [], stats: [] };   // pids waiting for a match, per game mode
const games = new Map();   // gameId → game
const modeOf = (m) => (m === "stats" ? "stats" : "battle");
const queueOf = (p) => queues[modeOf(p.mode)];

// names end up in the opponent's DOM — whitelist hard, never trust the client
const cleanName = (s) => String(s || "").replace(/[^\w.…-]/g, "").slice(0, 24) || "?";

function player(pid, name) {
  let p = players.get(pid);
  if (!p) { p = { pid, name: "?", streams: new Set(), lastSeen: Date.now(), gameId: null, inQueue: false }; players.set(pid, p); }
  if (name) p.name = cleanName(name);
  return p;
}

// A pid may hold several SSE streams (duplicated tab, reconnect overlap) —
// mirror state to all of them instead of kicking the older one.
function send(p, obj) {
  if (!p) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of p.streams) { try { res.write(line); } catch { /* dead pipe — close event handles it */ } }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tryMatch() {
  for (const queue of Object.values(queues))
    while (queue.length >= 2) {
      // random pairing, per the spec — pull two random waiting players
      const a = queue.splice(crypto.randomInt(queue.length), 1)[0];
      const b = queue.splice(crypto.randomInt(queue.length), 1)[0];
      startGame(a, b).catch((e) => console.error("startGame:", e.message));
    }
}

function requeue(p) {
  if (!p) return;
  if (!p.inQueue && !(p.gameId && games.has(p.gameId))) {
    p.inQueue = true;
    queueOf(p).push(p.pid);
    send(p, { t: "queued" });
  }
  tryMatch();
}

// Tear down a game still in its "loading" phase (deck metadata being fetched).
// `leaverSeat` abandoned it; the other player goes straight back to the queue.
function cancelLoading(g, leaverSeat) {
  games.delete(g.id);
  g.pids.forEach((pid, i) => {
    const p = players.get(pid);
    if (p && p.gameId === g.id) p.gameId = null;
    if (i !== leaverSeat) requeue(p);
  });
}

async function startGame(aPid, bPid) {
  const pa = players.get(aPid), pb = players.get(bPid);
  if (!pa || !pb) { requeue(pa || pb); return; }
  pa.inQueue = pb.inQueue = false;

  // Bind both players to the game BEFORE any await — otherwise a re-queue or
  // leave during the (network-bound) deck load double-seats or traps them.
  const g = {
    id: crypto.randomUUID(),
    mode: modeOf(pa.mode),   // both came out of the same per-mode queue
    pids: [aPid, bPid],
    seats: null,
    round: 1, totalRounds: 0,
    leader: crypto.randomInt(2),
    phase: "loading",        // loading → lead → follow → reveal → (lead… | over)
    lead: null,              // {cardId, field, dir}
    reveal: null,
    over: null,
    timer: null, deadline: 0,
  };
  games.set(g.id, g);
  pa.gameId = pb.gameId = g.id;

  // authoritative metadata for every card, via the shared cache (the client
  // already warmed it while building the deck, so this is usually instant)
  const load = async (p) =>
    (await Promise.all(p.deckIds.map(getCard))).filter(Boolean);
  let da = [], db = [];
  try { [da, db] = await Promise.all([load(pa), load(pb)]); } catch { /* treated as failed decks below */ }

  if (games.get(g.id) !== g || g.phase !== "loading") return; // cancelled while loading

  // Strict: a deck that lost cards to failed fetches must not silently start
  // a shorter match. The failed side is bounced; the innocent side re-queues.
  const bad = [da.length !== pa.deckIds.length || da.length < DECK_MIN,
               db.length !== pb.deckIds.length || db.length < DECK_MIN];
  if (bad[0] || bad[1]) {
    games.delete(g.id);
    [pa, pb].forEach((p, i) => {
      if (p.gameId === g.id) p.gameId = null;
      if (bad[i]) { send(p, { t: "error", msg: "DECK FAILED" }); send(p, { t: "hello" }); }
      else requeue(p);
    });
    return;
  }

  if (g.mode === "battle") {
    g.seats = [battle.mkSeat(pa, shuffle(da)), battle.mkSeat(pb, shuffle(db))];
    battle.initBattle(g);   // → "setup": both pick an active
    arm(g);
    push(g);
    return;
  }
  const mkSeat = (p, deck) => {
    shuffle(deck);
    const hand = deck.splice(0, Math.min(HAND_SIZE, deck.length));
    return { pid: p.pid, name: p.name, hand, pile: deck, wins: 0 };
  };
  g.totalRounds = Math.min(da.length, db.length);
  g.seats = [mkSeat(pa, da), mkSeat(pb, db)];
  g.phase = "lead";
  arm(g);
  push(g);
}

// Apply a battle.js action result: false = illegal, "wait" = setup pick
// recorded (timer keeps running for the other side), anything else advances
// the game — re-arm the move timer, or finish on {over}.
function applyBattle(g, r) {
  if (r === false) return false;
  if (r === "wait") { push(g); return true; }
  if (r && r.over) { finish(g, null, r.over); return true; }
  arm(g);
  push(g);
  return true;
}

function arm(g) {
  clearTimeout(g.timer);
  g.deadline = Date.now() + TURN_MS;
  g.timer = setTimeout(() => autoplay(g), TURN_MS);
}

function autoplay(g) {
  // the slow player forfeits the choice, not the game — a legal move is made
  if (g.mode === "battle") { applyBattle(g, battle.autoMove(g)); return; }
  if (g.phase === "lead") {
    const s = g.seats[g.leader];
    if (!s.hand.length) return;
    doLead(g, g.leader, s.hand[crypto.randomInt(s.hand.length)].id,
      FIELDS[crypto.randomInt(FIELDS.length)], crypto.randomInt(2) ? "high" : "low");
  } else if (g.phase === "follow") {
    const s = g.seats[1 - g.leader];
    if (!s.hand.length) return;
    doFollow(g, 1 - g.leader, s.hand[crypto.randomInt(s.hand.length)].id);
  }
}

function seatOf(g, pid) {
  return g.pids.indexOf(pid);
}

function doLead(g, seat, cardId, field, dir) {
  if (g.phase !== "lead" || seat !== g.leader) return false;
  if (!FIELDS.includes(field) || (dir !== "high" && dir !== "low")) return false;
  if (!g.seats[seat].hand.some((c) => c.id === cardId)) return false;
  g.lead = { cardId, field, dir };
  g.phase = "follow";
  arm(g);
  push(g);
  return true;
}

function doFollow(g, seat, cardId) {
  if (g.phase !== "follow" || seat !== 1 - g.leader) return false;
  const F = g.seats[seat], L = g.seats[g.leader];
  if (!F.hand.some((c) => c.id === cardId)) return false;

  const take = (hand, id) => hand.splice(hand.findIndex((c) => c.id === id), 1)[0];
  const lc = take(L.hand, g.lead.cardId), fc = take(F.hand, cardId);
  const { field, dir } = g.lead;
  const lv = Number(lc[field]) || 0, fv = Number(fc[field]) || 0;
  let winner = -1; // tie
  if (lv !== fv) winner = (dir === "high") === (lv > fv) ? g.leader : 1 - g.leader;
  if (winner >= 0) g.seats[winner].wins++;
  for (const s of g.seats) if (s.pile.length && s.hand.length < HAND_SIZE) s.hand.push(s.pile.shift());

  g.reveal = { field, dir, leadSeat: g.leader, leadCard: lc, folCard: fc, winner };
  g.phase = "reveal";
  clearTimeout(g.timer);
  g.deadline = 0;
  g.timer = setTimeout(() => advance(g), REVEAL_MS);
  push(g);
  return true;
}

function advance(g) {
  g.reveal = null;
  g.lead = null;
  if (g.round >= g.totalRounds) return finish(g, null);
  g.round++;
  g.leader = 1 - g.leader; // "οι γύροι παίζονται εναλλάξ"
  g.phase = "lead";
  arm(g);
  push(g);
}

// forfeitLoser: seat index that abandoned, or null for a played-out game
// (battle games pass their {winner, reason} outcome as `out`)
function finish(g, forfeitLoser, out) {
  clearTimeout(g.timer);
  g.phase = "over";
  const [a, b] = g.seats;
  if (forfeitLoser != null) g.over = { winner: 1 - forfeitLoser, forfeit: true, reason: "forfeit" };
  else if (g.mode === "battle") g.over = { ...(out || battle.outcome(g, "end")), forfeit: false };
  else g.over = { winner: a.wins === b.wins ? -1 : (a.wins > b.wins ? 0 : 1), forfeit: false, reason: "rounds" };
  push(g);
  for (const pid of g.pids) {
    const p = players.get(pid);
    if (p && p.gameId === g.id) p.gameId = null;
  }
  games.delete(g.id);
}

function view(g, seat) {
  if (g.mode === "battle") return battle.view(g, seat);
  const me = g.seats[seat], op = g.seats[1 - seat];
  const v = {
    t: "game", mode: "stats",
    round: g.round, totalRounds: g.totalRounds, phase: g.phase,
    youLead: g.leader === seat,
    deadline: g.phase === "lead" || g.phase === "follow" ? g.deadline : 0,
    you: { wins: me.wins, hand: me.hand, pile: me.pile.length },
    opp: { name: op.name, wins: op.wins, hand: op.hand.length, pile: op.pile.length },
    lead: null, reveal: null, over: null,
  };
  if (g.lead && g.phase === "follow")
    v.lead = { field: g.lead.field, dir: g.lead.dir, cardId: g.leader === seat ? g.lead.cardId : null };
  if (g.reveal) {
    const mine = g.reveal.leadSeat === seat;
    v.reveal = {
      field: g.reveal.field, dir: g.reveal.dir,
      yourCard: mine ? g.reveal.leadCard : g.reveal.folCard,
      oppCard: mine ? g.reveal.folCard : g.reveal.leadCard,
      winner: g.reveal.winner === -1 ? "tie" : g.reveal.winner === seat ? "you" : "opp",
    };
  }
  if (g.over)
    v.over = {
      result: g.over.winner === -1 ? "draw" : g.over.winner === seat ? "win" : "lose",
      forfeit: g.over.forfeit, you: me.wins, opp: op.wins,
    };
  return v;
}

function push(g) {
  g.seats.forEach((s, i) => send(players.get(s.pid), view(g, i)));
}

// sweep: drop vanished players from the queue, forfeit abandoned games
setInterval(() => {
  const gone = (pid) => {
    const p = players.get(pid);
    return !p || (!p.streams.size && Date.now() - p.lastSeen > GONE_MS);
  };
  for (const queue of Object.values(queues))
    for (let i = queue.length - 1; i >= 0; i--)
      if (gone(queue[i])) { const p = players.get(queue[i]); if (p) p.inQueue = false; queue.splice(i, 1); }
  for (const g of [...games.values()])
    if (g.phase !== "over") {
      const left = g.pids.findIndex(gone);
      if (left >= 0) g.phase === "loading" ? cancelLoading(g, left) : finish(g, left);
    }
}, 5000);

// ------------------------------------------------------------------- http

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 65536) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  try {
    // --- recursive passthrough: HTML inscriptions rendered in card iframes
    // load their assets with RELATIVE urls (/content/<id>, /r/..., legacy
    // /blockheight) — serve those on our origin too, CORS-open (the card
    // iframes are sandboxed to an opaque origin, so fetch() needs ACAO *)
    if (path.startsWith("/content/") || path.startsWith("/r/") || /^\/(blockheight|blockhash|blocktime)$/.test(path)) {
      const immutable = /^\/content\/[0-9a-f]{64}i\d+$/.test(path);
      const ok = immutable
        || (/^\/r\/[A-Za-z0-9/._:-]+$/.test(path) && !path.includes(".."))
        || /^\/(blockheight|blockhash|blocktime)$/.test(path);
      if (!ok) return json(res, 400, { error: "bad path" });
      const e = await ordFetch(path, immutable ? Infinity : 60_000);
      if (!e) return json(res, 502, { error: "ord gateway" });
      res.writeHead(200, {
        "content-type": e.ct,
        "cache-control": immutable ? "public, max-age=604800" : "public, max-age=60",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox allow-scripts",
      });
      return res.end(e.body);
    }

    // --- ord proxy (whitelisted paths only — this is not an open proxy)
    if (path.startsWith("/o/")) {
      const target = path.slice(2); // "/content/..." | "/r/inscription/..."
      const okContent = /^\/content\/[0-9a-f]{64}i\d+$/.test(target);
      const okMeta = /^\/r\/inscription\/[0-9a-f]{64}i\d+$/.test(target);
      if (!okContent && !okMeta) return json(res, 400, { error: "bad path" });
      const e = await ordFetch(target, Infinity);
      if (!e) return json(res, 502, { error: "ord gateway" });
      // sandbox: inscriptions are attacker-controlled active content — opened
      // top-level they must get an opaque origin (no storage, no same-origin
      // API access). allow-scripts keeps animated HTML inscriptions working.
      res.writeHead(200, {
        "content-type": e.ct, "cache-control": "public, max-age=604800",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox allow-scripts",
      });
      return res.end(e.body);
    }

    // --- full card (meta + child/reinscription counts), server-computed
    if (path.startsWith("/api/card/")) {
      const id = path.slice(10);
      if (!INSC_ID.test(id)) return json(res, 400, { error: "bad id" });
      const c = await getCard(id);
      return c ? json(res, 200, c) : json(res, 502, { error: "ord gateway" });
    }

    // --- the percentile scale behind HP/ATK/DEF (info sheet footer, debugging)
    if (path === "/api/scale") return json(res, 200, SCALE);

    // --- wallet inscriptions by address
    if (path.startsWith("/api/addr/")) {
      const addr = decodeURIComponent(path.slice(10)).trim();
      if (!/^(bc1|tb1|[13])[a-zA-Z0-9]{20,90}$/.test(addr)) return json(res, 400, { error: "bad address" });
      try { return json(res, 200, await addrInscriptions(addr)); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    // --- SSE stream
    if (path === "/events") {
      const pid = url.searchParams.get("pid") || "";
      if (!/^[\w-]{8,64}$/.test(pid)) return json(res, 400, { error: "bad pid" });
      const p = player(pid, (url.searchParams.get("name") || "").slice(0, 24));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
      res.write(":ok\n\n");
      p.streams.add(res);
      p.lastSeen = Date.now();
      const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch { } }, 15_000);
      req.on("close", () => {
        clearInterval(ping);
        p.streams.delete(res);
        p.lastSeen = Date.now();
      });
      // resume where they left off
      const g = p.gameId && games.get(p.gameId);
      if (g && g.phase !== "loading") send(p, view(g, seatOf(g, pid)));
      else if (g) send(p, { t: "queued" });
      else send(p, { t: p.inQueue ? "queued" : "hello" });
      return;
    }

    // --- actions
    if (req.method === "POST" && path === "/api/queue") {
      const b = await readBody(req);
      const pid = String(b.pid || "");
      if (!/^[\w-]{8,64}$/.test(pid)) return json(res, 400, { error: "bad pid" });
      const deck = [...new Set((Array.isArray(b.deck) ? b.deck : []).filter((id) => typeof id === "string" && INSC_ID.test(id)))];
      if (deck.length < DECK_MIN || deck.length > DECK_MAX) return json(res, 400, { error: `deck ${DECK_MIN}-${DECK_MAX}` });
      const p = player(pid, String(b.name || "").slice(0, 24));
      if (p.gameId && games.has(p.gameId)) { // already playing — resend state
        const g = games.get(p.gameId);
        if (g.phase === "loading") send(p, { t: "queued" });
        else send(p, view(g, seatOf(g, pid)));
        return json(res, 200, { ok: true });
      }
      p.deckIds = deck;
      if (p.inQueue && modeOf(p.mode) !== modeOf(b.mode)) {   // switched mode while waiting
        const q = queueOf(p); const i = q.indexOf(pid); if (i >= 0) q.splice(i, 1); p.inQueue = false;
      }
      p.mode = modeOf(b.mode);
      if (!p.inQueue) { p.inQueue = true; queueOf(p).push(pid); }
      send(p, { t: "queued" });
      json(res, 200, { ok: true });
      return tryMatch();
    }

    if (req.method === "POST" && path === "/api/play") {
      const b = await readBody(req);
      const p = players.get(String(b.pid || ""));
      const g = p && p.gameId && games.get(p.gameId);
      if (!g || g.phase === "loading") return json(res, 404, { error: "no game" });
      const seat = seatOf(g, p.pid);
      let ok;
      if (g.mode === "battle") {
        const action = String(b.action || ""), cardId = String(b.cardId || "");
        const r = action === "active" ? (g.phase === "promote" ? battle.promote(g, seat, cardId) : battle.chooseActive(g, seat, cardId))
          : action === "attack" ? battle.attack(g, seat)
          : action === "swap" ? battle.swap(g, seat, cardId)
          : false;
        ok = applyBattle(g, r);
      } else {
        ok = g.phase === "lead"
          ? doLead(g, seat, String(b.cardId || ""), String(b.field || ""), String(b.dir || ""))
          : doFollow(g, seat, String(b.cardId || ""));
      }
      return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "bad move" });
    }

    if (req.method === "POST" && path === "/api/leave") {
      const b = await readBody(req);
      const p = players.get(String(b.pid || ""));
      if (p) {
        if (p.inQueue) { p.inQueue = false; const q = queueOf(p); const i = q.indexOf(p.pid); if (i >= 0) q.splice(i, 1); }
        const g = p.gameId && games.get(p.gameId);
        if (g && g.phase === "loading") cancelLoading(g, seatOf(g, p.pid));
        else if (g && g.phase !== "over") finish(g, seatOf(g, p.pid));
        send(p, { t: "hello" });
      }
      return json(res, 200, { ok: true });
    }

    // --- static
    let file = path === "/" ? "/index.html" : path;
    file = join(ROOT, file.replace(/\.\./g, ""));
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end("404"); }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    return res.end(readFileSync(file));
  } catch (e) {
    console.error(req.method, path, e.message);
    if (!res.headersSent) json(res, 500, { error: "server" });
  }
});

server.listen(PORT, () => console.log(`ORDINAL CARDS  →  http://localhost:${PORT}`));
