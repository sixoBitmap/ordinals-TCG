// Combat stats derived from ordinal data. Shared by the server, the scale
// sampler and the tests — the client never derives stats itself.
//
//   content_length → HP      fee_rate (sat/vB) → ATTACK      fee → DEFENSE
//
// Each raw value is turned into a percentile rank (1..100) against a sampled
// slice of the Ordinals universe (scale-v1.json), so "100" means "among the
// biggest / most expensive inscriptions ever", not a theoretical Bitcoin max.

import { readFileSync } from "node:fs";

// Reveal tx: inscription bytes sit in the witness (counted ÷4 in vbytes) plus
// roughly 180 vB of non-witness overhead.
export const REVEAL_OVERHEAD_VB = 180;
export const feeRate = (fee, len) => (Number(fee) || 0) / ((Number(len) || 0) / 4 + REVEAL_OVERHEAD_VB);

// breaks = 99 ascending breakpoints (p1..p99). Returns the percentile 1..100.
export function pct(x, breaks) {
  let n = 0;
  while (n < breaks.length && x >= breaks[n]) n++;
  return Math.min(100, n + 1);
}

// Content size is NOT rank-normalized: the sampled universe is ~90% tiny
// text/JSON (median 53 bytes), so by rank every image sits at p99+ and all
// art cards would collapse to HP 99–100. A log scale up to a 400 KB ceiling
// spreads them: 53 B → 31, 800 B → 52, 57 KB → 85, ≥400 KB → 100.
export const SIZE_CAP = 400_000;
export const sizeScore = (len) =>
  Math.min(100, Math.max(1, Math.round(100 * Math.log1p(Math.max(0, Number(len) || 0)) / Math.log1p(SIZE_CAP))));

// Three elements from the content type. Rock-paper-scissors: IMAGE beats
// TEXT, TEXT beats CODE, CODE beats IMAGE.
export function typeOf(ct = "") {
  if (/^(image|audio|video|model)\//i.test(ct)) return "IMAGE";
  if (/^text\/plain|^application\/json|^text\/(markdown|csv)/i.test(ct)) return "TEXT";
  return "CODE";
}
export const BEATS = { IMAGE: "TEXT", TEXT: "CODE", CODE: "IMAGE" };
export const beats = (a, b) => BEATS[a] === b;
export const TYPE_MULT = 1.5;

// Tier from the card's best percentile. GOD is reserved for a future
// inscribed God Set (top-10 membership) and is never produced here.
export function tierOf(best) {
  return best >= 99 ? "LEGENDARY" : best >= 95 ? "EPIC" : best >= 80 ? "RARE" : "COMMON";
}

// m = raw /r/inscription fields. Floors keep tiny text inscriptions playable:
// HP 21..100, ATK 6..100, DEF 1..100.
export function battleStats(m, scale) {
  const len = Number(m.content_length) || 0, fee = Number(m.fee) || 0;
  const pHp = sizeScore(len);
  const pAtk = pct(feeRate(fee, len), scale.fee_rate);
  const pDef = pct(fee, scale.fee);
  const hp = 20 + Math.round(pHp * 0.8);
  return {
    hp, hpMax: hp,
    atk: 5 + Math.round(pAtk * 0.95),
    def: pDef,
    type: typeOf(m.content_type),
    tier: tierOf(Math.max(pHp, pAtk, pDef)),
    pct: { hp: pHp, atk: pAtk, def: pDef },
  };
}

// Log-spaced placeholder breakpoints, used only when scale-v1.json is missing
// or malformed. Replaced by real sampled values via scripts/build-scale.mjs.
const geo = (lo, hi) => Array.from({ length: 99 }, (_, i) => Math.round(lo * Math.pow(hi / lo, i / 98)));
export const SCALE_FALLBACK = {
  version: 0, method: "fallback-geometric", sampleSize: 0,
  content_length: geo(8, 400_000),
  fee_rate: geo(1, 300).map((v, i) => +(1 * Math.pow(300, i / 98)).toFixed(2)),
  fee: geo(300, 2_000_000),
};

export function loadScale(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    for (const k of ["content_length", "fee_rate", "fee"]) {
      if (!Array.isArray(j[k]) || j[k].length !== 99) throw new Error(`${k}: expected 99 breakpoints`);
      for (let i = 1; i < 99; i++) if (j[k][i] < j[k][i - 1]) throw new Error(`${k}: breakpoints not ascending`);
    }
    return j;
  } catch (e) {
    console.warn(`scale: ${e.message} — using built-in fallback scale`);
    return SCALE_FALLBACK;
  }
}
