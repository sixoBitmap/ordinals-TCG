import { test } from "node:test";
import assert from "node:assert/strict";
import { pct, sizeScore, typeOf, BEATS, beats, tierOf, feeRate, battleStats, SCALE_FALLBACK, loadScale } from "../stats.js";

test("sizeScore spreads image-sized inscriptions on a log scale", () => {
  assert.equal(sizeScore(0), 1);
  assert.equal(sizeScore(53), 31);
  assert.equal(sizeScore(793), 52);
  assert.equal(sizeScore(57079), 85);
  assert.equal(sizeScore(400_000), 100);
  assert.equal(sizeScore(4_000_000), 100);
  let prev = 0;
  for (let x = 0; x < 500_000; x += 997) { const s = sizeScore(x); assert.ok(s >= prev); prev = s; }
});

const breaks = Array.from({ length: 99 }, (_, i) => (i + 1) * 10); // p1=10 … p99=990

test("pct maps below-p1 to 1, at/above p99 to 100, monotone in between", () => {
  assert.equal(pct(0, breaks), 1);
  assert.equal(pct(9, breaks), 1);
  assert.equal(pct(10, breaks), 2);
  assert.equal(pct(500, breaks), 51);
  assert.equal(pct(990, breaks), 100);
  assert.equal(pct(1e12, breaks), 100);
  let prev = 0;
  for (let x = 0; x <= 1000; x += 7) { const p = pct(x, breaks); assert.ok(p >= prev && p >= 1 && p <= 100); prev = p; }
});

test("typeOf buckets content types into the three elements", () => {
  assert.equal(typeOf("image/png"), "IMAGE");
  assert.equal(typeOf("image/svg+xml"), "IMAGE");
  assert.equal(typeOf("audio/mpeg"), "IMAGE");
  assert.equal(typeOf("text/plain;charset=utf-8"), "TEXT");
  assert.equal(typeOf("application/json"), "TEXT");
  assert.equal(typeOf("text/html;charset=utf-8"), "CODE");
  assert.equal(typeOf("application/javascript"), "CODE");
  assert.equal(typeOf(""), "CODE");
  assert.equal(typeOf(undefined), "CODE");
});

test("weakness triangle is a strict cycle", () => {
  assert.ok(beats("IMAGE", "TEXT") && beats("TEXT", "CODE") && beats("CODE", "IMAGE"));
  assert.ok(!beats("TEXT", "IMAGE") && !beats("IMAGE", "IMAGE") && !beats("CODE", "TEXT"));
  assert.deepEqual(new Set(Object.values(BEATS)), new Set(Object.keys(BEATS)));
});

test("tierOf thresholds", () => {
  assert.equal(tierOf(1), "COMMON");
  assert.equal(tierOf(79), "COMMON");
  assert.equal(tierOf(80), "RARE");
  assert.equal(tierOf(95), "EPIC");
  assert.equal(tierOf(99), "LEGENDARY");
  assert.equal(tierOf(100), "LEGENDARY");
});

test("feeRate approximates sat/vB with witness discount", () => {
  assert.ok(Math.abs(feeRate(180 * 10, 0) - 10) < 1e-9);       // no content: 180 vB overhead
  assert.ok(Math.abs(feeRate(1000 * 10, 3280) - 10) < 1e-9);   // 3280 B ÷ 4 + 180 = 1000 vB
  assert.equal(feeRate(undefined, undefined), 0);
});

test("battleStats stays inside its floors and ceilings", () => {
  const tiny = battleStats({ content_length: 0, fee: 1, content_type: "text/plain" }, SCALE_FALLBACK);
  const huge = battleStats({ content_length: 1e9, fee: 1e12, content_type: "image/png" }, SCALE_FALLBACK);
  assert.deepEqual([tiny.hp, tiny.atk, tiny.def], [21, 6, 1]);
  assert.deepEqual([huge.hp, huge.atk, huge.def], [100, 100, 100]);
  assert.equal(tiny.hpMax, tiny.hp);
  assert.equal(tiny.type, "TEXT");
  assert.equal(huge.tier, "LEGENDARY");
  assert.equal(tiny.tier, "COMMON");
});

test("loadScale falls back on a missing or malformed file", () => {
  assert.equal(loadScale("C:/definitely/missing.json"), SCALE_FALLBACK);
  assert.equal(SCALE_FALLBACK.content_length.length, 99);
  for (const k of ["content_length", "fee_rate", "fee"])
    for (let i = 1; i < 99; i++) assert.ok(SCALE_FALLBACK[k][i] >= SCALE_FALLBACK[k][i - 1], k);
});
