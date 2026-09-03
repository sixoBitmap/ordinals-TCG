import { test } from "node:test";
import assert from "node:assert/strict";
import { mkSeat, initBattle, chooseActive, attack, swap, promote, autoMove, outcome, damage, view, BENCH_MAX, KO_TARGET, TURN_LIMIT, MIN_DMG } from "../battle.js";

// synthetic cards: id = "c<n>", number = n
const card = (n, o = {}) => ({ id: "c" + n, number: n, hp: 50, hpMax: 50, atk: 40, def: 20, type: "IMAGE", tier: "COMMON", ...o });
const seat = (name, cards) => mkSeat({ pid: name, name }, cards);
function game(a, b) {
  const g = { id: "g", pids: ["A", "B"], seats: [seat("A", a), seat("B", b)], over: null, deadline: 123 };
  initBattle(g);
  return g;
}

test("mkSeat clones cards and splits hand/pile", () => {
  const src = [card(1), card(2), card(3), card(4), card(5), card(6)];
  const s = seat("A", src);
  assert.equal(s.bench.length, BENCH_MAX + 1);
  assert.equal(s.pile.length, 2);
  s.bench[0].hp = 1;
  assert.equal(src[0].hp, 50, "source card must not be mutated");
});

test("setup: both choose, older inscription moves first, opp pick hidden until start", () => {
  const g = game([card(10), card(11), card(12)], [card(5), card(6), card(7)]);
  assert.equal(chooseActive(g, 0, "c10"), "wait");
  assert.equal(view(g, 1).opp.active, null);
  assert.equal(view(g, 1).opp.ready, true);
  assert.equal(chooseActive(g, 0, "c11"), false, "cannot choose twice");
  assert.equal(chooseActive(g, 1, "c5"), "start");
  assert.equal(g.phase, "turn");
  assert.equal(g.turn, 1, "#5 is older than #10");
  assert.equal(view(g, 1).yourTurn, true);
  assert.equal(view(g, 0).yourTurn, false);
  assert.equal(view(g, 0).last.first, "opp");
  assert.equal(view(g, 0).opp.active.id, "c5");
});

test("damage: floor, DEF halving, type advantage", () => {
  assert.deepEqual(damage(card(1, { atk: 40 }), card(2, { def: 20 })), { dmg: 30, mult: 1 });
  assert.deepEqual(damage(card(1, { atk: 10 }), card(2, { def: 90 })), { dmg: MIN_DMG, mult: 1 });
  assert.deepEqual(damage(card(1, { atk: 40, type: "IMAGE" }), card(2, { def: 20, type: "TEXT" })), { dmg: 45, mult: 1.5 });
  assert.deepEqual(damage(card(1, { atk: 40, type: "TEXT" }), card(2, { def: 20, type: "IMAGE" })), { dmg: 30, mult: 1 });
});

test("attack → knockout → promote (bench refills) → race to KO_TARGET", () => {
  const g = game([card(1, { atk: 100, hp: 100 }), card(2), card(3), card(4)], [card(9, { hp: 30 }), card(8, { hp: 30 }), card(7, { hp: 30 }), card(6, { hp: 30 }), card(5, { hp: 30 })]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");
  assert.equal(g.turn, 0);
  assert.equal(attack(g, 1), false, "not B's turn");
  let r = attack(g, 0);
  assert.deepEqual(r, { ko: true });
  assert.equal(g.phase, "promote"); assert.equal(g.promoteSeat, 1);
  assert.equal(g.seats[0].kos, 1);
  assert.equal(g.seats[1].bench.length, BENCH_MAX, "bench still full at KO time");
  assert.equal(g.seats[1].pile.length, 1);
  assert.equal(attack(g, 0), false, "no attacking during promote");
  assert.equal(promote(g, 0, "c2"), false, "wrong seat");
  assert.deepEqual(promote(g, 1, "c8"), {});
  assert.equal(g.seats[1].bench.length, BENCH_MAX, "refilled from the pile after promoting");
  assert.equal(g.seats[1].pile.length, 0);
  assert.equal(g.turn, 1, "promoter acts next");
  r = attack(g, 1);           // B hits A: 40 - 10 = 30 → A active 100 → 70
  assert.deepEqual(r, {});
  assert.equal(g.seats[0].active.hp, 70);
  assert.deepEqual(attack(g, 0), { ko: true }); promote(g, 1, "c7");
  attack(g, 1);
  r = attack(g, 0);
  assert.deepEqual(r, { over: { winner: 0, reason: "ko" } });
  assert.equal(g.seats[0].kos, KO_TARGET);
});

test("out of cards ends the match before KO_TARGET", () => {
  const g = game([card(1, { atk: 100, hp: 100 }), card(2), card(3)], [card(9, { hp: 10 }), card(8, { hp: 10 }), card(7, { hp: 10 })]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");
  assert.deepEqual(attack(g, 0), { ko: true }); promote(g, 1, "c8"); attack(g, 1);
  assert.deepEqual(attack(g, 0), { ko: true }); promote(g, 1, "c7"); attack(g, 1);
  assert.deepEqual(attack(g, 0), { over: { winner: 0, reason: "ko" } }); // 3 KOs coincide with last card
  const h = game([card(1, { atk: 100, hp: 100 }), card(2), card(3)], [card(9, { hp: 10 }), card(8, { hp: 10 })]);
  chooseActive(h, 0, "c1"); chooseActive(h, 1, "c9");
  assert.deepEqual(attack(h, 0), { ko: true }); promote(h, 1, "c8"); attack(h, 1);
  assert.deepEqual(attack(h, 0), { over: { winner: 0, reason: "cards" } });
});

test("a knockout with an empty bench draws from the pile instead of ending the match", () => {
  const g = game([card(1, { atk: 100, hp: 100 }), card(2), card(3)], [card(9, { hp: 10 }), card(8, { hp: 10 }), card(7, { hp: 10 }), card(6, { hp: 10 }), card(5, { hp: 10 }), card(4, { hp: 10 })]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");        // B bench c8 c7 c6, pile c5 c4
  g.seats[1].bench.length = 0;                                 // simulate an emptied bench
  assert.deepEqual(attack(g, 0), { ko: true });
  assert.equal(g.seats[1].bench.length, 1, "rescue draw");
  assert.equal(g.seats[1].bench[0].id, "c5");
});

test("swap keeps damage on the benched card and passes the turn", () => {
  const g = game([card(1), card(2), card(3)], [card(9), card(8), card(7)]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");
  attack(g, 0);                                   // B active 50 → 20
  assert.equal(swap(g, 0, "c2"), false, "not A's turn");
  assert.deepEqual(swap(g, 1, "c8"), {});
  assert.equal(g.seats[1].active.id, "c8");
  assert.equal(g.seats[1].bench.find((c) => c.id === "c9").hp, 20);
  assert.equal(g.turn, 0);
  assert.equal(g.last.kind, "swap");
});

test("turn limit ends the match by tiebreak", () => {
  const g = game([card(1, { atk: 5, def: 100, hp: 1000 }), card(2)], [card(9, { atk: 5, def: 100, hp: 1000 }), card(8)]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");
  let r;
  for (let i = 0; i < TURN_LIMIT; i++) { r = autoMove(g); if (r.over) break; }
  assert.equal(r.over.reason, "limit");
  assert.equal(g.turnNo, TURN_LIMIT);
  // equal KOs and HP here → older active (#1) wins
  assert.equal(r.over.winner, 0);
  assert.deepEqual(outcome(g, "x").winner, 0);
});

test("autoMove picks actives in setup, attacks on turn, promotes after KO", () => {
  const g = game([card(1, { atk: 100, hp: 30 }), card(2, { hp: 90 }), card(3)], [card(9, { hp: 10 }), card(8, { hp: 60 }), card(7)]);
  assert.equal(autoMove(g), "start");
  assert.equal(g.seats[0].active.id, "c2", "highest hp chosen");
  assert.equal(g.seats[1].active.id, "c8");
  assert.equal(g.turn, 0);
  assert.equal(autoMove(g).ko, undefined);      // A(c2 atk 40) hits B(c8 def 20): 30 → 30 left
  assert.equal(g.turn, 1);
});

test("view marks whose turn it is and never leaks the opponent bench", () => {
  const g = game([card(1), card(2), card(3)], [card(9), card(8), card(7)]);
  chooseActive(g, 0, "c1"); chooseActive(g, 1, "c9");
  const v = view(g, 1);
  assert.equal(v.mode, "battle");
  assert.equal(typeof v.opp.bench, "number");
  assert.equal(v.you.bench.length, 2);
  assert.equal(v.yourTurn, false);
  assert.equal(v.deadline, 0);
  assert.equal(view(g, 0).deadline, 123);
});
