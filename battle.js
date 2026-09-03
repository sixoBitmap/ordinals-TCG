// BATTLE mode — Pokémon-style state machine over ordinal cards.
// Pure transitions on the game object; server.js owns timers, SSE and finish().
//
//   setup   → both players pick an ACTIVE from their opening hand
//   turn    → the player on turn ATTACKs (or SWAPs active ↔ bench)
//   promote → after a knockout the victim promotes a bench card, then acts
//   over    → first to KO_TARGET knockouts, or the opponent runs out of cards

import { BEATS, TYPE_MULT } from "./stats.js";

export const BENCH_MAX = 3;      // hand = 1 active + 3 bench (fits the 3-column hand row)
export const KO_TARGET = 3;      // "prize cards"
export const TURN_LIMIT = 60;    // hard cap on actions — no infinite swap loops
export const MIN_DMG = 5;        // tanks stay killable

// deck: already shuffled, authoritative cards. Cards are CLONED — hp is
// mutated during play and the server's card cache must never change.
export function mkSeat(p, deck) {
  const clone = (c) => ({ ...c });
  const bench = deck.slice(0, BENCH_MAX + 1).map(clone);
  return { pid: p.pid, name: p.name, active: null, bench, pile: deck.slice(BENCH_MAX + 1).map(clone), gone: [], kos: 0 };
}

export function initBattle(g) {
  g.phase = "setup"; g.turn = 0; g.promoteSeat = null; g.turnNo = 0; g.seq = 0; g.last = null;
}

const takeBench = (s, id) => { const i = s.bench.findIndex((c) => c.id === id); return i < 0 ? null : s.bench.splice(i, 1)[0]; };

// setup: returns false (illegal), "wait" (other side still choosing) or
// "start" (both chosen → turn phase; the older inscription moves first).
export function chooseActive(g, seat, cardId) {
  if (g.phase !== "setup") return false;
  const s = g.seats[seat];
  if (s.active) return false;
  const c = takeBench(s, cardId);
  if (!c) return false;
  s.active = c;
  const [a, b] = g.seats;
  if (!a.active || !b.active) return "wait";
  g.turn = a.active.number <= b.active.number ? 0 : 1;
  g.phase = "turn";
  g.last = { seq: ++g.seq, kind: "start", by: g.turn, first: g.turn };
  return "start";
}

export function damage(att, def) {
  const mult = BEATS[att.type] === def.type ? TYPE_MULT : 1;
  return { dmg: Math.round(Math.max(MIN_DMG, att.atk - def.def / 2) * mult), mult };
}

// Actions return false when illegal, otherwise an object: {} plain, {ko:true}
// (victim must promote), or {over:{winner, reason}} for the server to finish.
export function attack(g, seat) {
  if (g.phase !== "turn" || g.turn !== seat) return false;
  const A = g.seats[seat], D = g.seats[1 - seat];
  const { dmg, mult } = damage(A.active, D.active);
  D.active.hp = Math.max(0, D.active.hp - dmg);
  g.turnNo++;
  const ko = D.active.hp === 0;
  g.last = { seq: ++g.seq, kind: "attack", by: seat, dmg, mult, ko, targetId: D.active.id };
  if (ko) {
    A.kos++;
    D.gone.push(D.active);
    D.active = null;
    if (A.kos >= KO_TARGET) return { over: { winner: seat, reason: "ko" } };
    if (!D.bench.length && D.pile.length) D.bench.push(D.pile.shift()); // rescue draw: never stranded with a pile
    if (!D.bench.length) return { over: { winner: seat, reason: "cards" } };
    g.phase = "promote";
    g.promoteSeat = 1 - seat;
    return { ko: true };
  }
  if (g.turnNo >= TURN_LIMIT) return { over: outcome(g, "limit") };
  g.turn = 1 - seat;
  return {};
}

export function swap(g, seat, cardId) {
  if (g.phase !== "turn" || g.turn !== seat) return false;
  const s = g.seats[seat];
  const c = takeBench(s, cardId);
  if (!c) return false;
  s.bench.push(s.active);   // damage taken stays on the benched card
  s.active = c;
  g.turnNo++;
  g.last = { seq: ++g.seq, kind: "swap", by: seat };
  if (g.turnNo >= TURN_LIMIT) return { over: outcome(g, "limit") };
  g.turn = 1 - seat;
  return {};
}

export function promote(g, seat, cardId) {
  if (g.phase !== "promote" || g.promoteSeat !== seat) return false;
  const s = g.seats[seat];
  const c = takeBench(s, cardId);
  if (!c) return false;
  s.active = c;
  if (s.pile.length && s.bench.length < BENCH_MAX) s.bench.push(s.pile.shift()); // refill the bench
  g.phase = "turn";
  g.turn = seat;            // the promoter acts next — the attacker's turn is spent
  g.promoteSeat = null;
  g.last = { seq: ++g.seq, kind: "promote", by: seat };
  return {};
}

// Non-forfeit tiebreak: more knockouts → more remaining HP → older active.
export function outcome(g, reason) {
  const [a, b] = g.seats;
  const hp = (s) => (s.active ? s.active.hp : 0) + s.bench.reduce((t, c) => t + c.hp, 0);
  let winner;
  if (a.kos !== b.kos) winner = a.kos > b.kos ? 0 : 1;
  else if (hp(a) !== hp(b)) winner = hp(a) > hp(b) ? 0 : 1;
  else winner = (a.active?.number ?? Infinity) <= (b.active?.number ?? Infinity) ? 0 : 1;
  return { winner, reason };
}

const bestCard = (cards) =>
  cards.reduce((b, c) => (!b || c.hp > b.hp || (c.hp === b.hp && c.number < b.number) ? c : b), null);

// Timer expiry: make the pending move(s) for whoever is due. Never swaps.
export function autoMove(g) {
  if (g.phase === "setup") {
    let r = "wait";
    for (let i = 0; i < 2; i++) {
      const s = g.seats[i];
      if (!s.active && s.bench.length) r = chooseActive(g, i, bestCard(s.bench).id);
    }
    return r;
  }
  if (g.phase === "turn") return attack(g, g.turn);
  if (g.phase === "promote") return promote(g, g.promoteSeat, bestCard(g.seats[g.promoteSeat].bench).id);
  return false;
}

export function view(g, seat) {
  const me = g.seats[seat], op = g.seats[1 - seat];
  const yourTurn = g.phase === "setup" ? !me.active
    : g.phase === "turn" ? g.turn === seat
    : g.phase === "promote" ? g.promoteSeat === seat : false;
  const who = (i) => (i === seat ? "you" : "opp");
  return {
    t: "game", mode: "battle", phase: g.phase, turnNo: g.turnNo, koTarget: KO_TARGET, seq: g.seq,
    yourTurn,
    deadline: yourTurn ? g.deadline : 0,
    you: { kos: me.kos, active: me.active, bench: me.bench, pile: me.pile.length, gone: me.gone.length },
    // the opponent's active is public once play starts (setup picks stay hidden); bench is a count
    opp: { name: op.name, kos: op.kos, active: g.phase === "setup" ? null : op.active, ready: !!op.active, bench: op.bench.length, pile: op.pile.length, gone: op.gone.length },
    last: g.last ? { ...g.last, by: who(g.last.by), first: g.last.first == null ? undefined : who(g.last.first) } : null,
    over: g.over ? {
      result: g.over.winner === -1 ? "draw" : g.over.winner === seat ? "win" : "lose",
      forfeit: g.over.forfeit, reason: g.over.reason, you: me.kos, opp: op.kos,
    } : null,
  };
}
