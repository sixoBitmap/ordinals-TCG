// One-off percentile sampler → scale-v1.json. Run locally from a home IP
// (ordinals.com blocks datacenter ranges; its JSON list API is disabled, so
// inscription NUMBER → ID goes through the HTML page, then the recursive
// /r/inscription/<id> endpoint gives exact fields).
//
//   node scripts/build-scale.mjs --sample 3000 --seed 1 --concurrency 2
//     [--out scale-v1.json] [--resume scratch/sample.jsonl] [--gateway https://ordinals.com]
//
// Resumable: every sampled inscription is appended to the resume file.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feeRate } from "../stats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"] : null).filter(Boolean));

const HTML_HOST = "https://ordinals.com";                       // number → id (HTML page)
const ORD = (args.gateway || "https://ordinals.com").replace(/\/$/, ""); // /r/ reads
const N = Number(args.sample) || 3000;
const SEED = Number(args.seed) || 1;
const CONC = Number(args.concurrency) || 2;
const GAP_MS = Number(args.gap) || 250;
const OUT = args.out || join(ROOT, "scale-v1.json");
const RESUME = args.resume || join(ROOT, "scratch", "sample.jsonl");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; ordinal-cards-sampler) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "*/*",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /[0-9a-f]{64}i\d+/g;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function get(url, extra = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { ...HEADERS, ...extra }, signal: AbortSignal.timeout(25_000) }); }
    catch (e) { if (attempt >= 4) throw e; await sleep(2000 * (attempt + 1)); continue; }
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep(3000 * (attempt + 1)); continue; }
    return r;
  }
}

async function inscriptionMeta(id) {
  const r = await get(`${ORD}/r/inscription/${id}`);
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// Highest inscription number: newest ids from the /inscriptions HTML page,
// else a binary search on /inscription/<n> existence.
async function maxNumber() {
  try {
    const html = await (await get(`${HTML_HOST}/inscriptions`, { Accept: "text/html" })).text();
    const ids = [...new Set(html.match(ID_RE) || [])].slice(0, 5);
    let best = 0;
    for (const id of ids) { const m = await inscriptionMeta(id); if (m && m.number > best) best = m.number; }
    if (best > 0) return best;
  } catch { /* fall through */ }
  let lo = 0, hi = 300_000_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await get(`${HTML_HOST}/inscription/${mid}`, { Accept: "text/html" });
    if (r.ok) lo = mid; else hi = mid;
    await sleep(GAP_MS);
  }
  return lo;
}

// number → the page's own id (the HTML also links neighbours, so verify
// against /r/inscription's number).
async function sampleOne(n) {
  const r = await get(`${HTML_HOST}/inscription/${n}`, { Accept: "text/html" });
  if (!r.ok) return null;
  const ids = [...new Set((await r.text()).match(ID_RE) || [])].slice(0, 4);
  for (const id of ids) {
    const m = await inscriptionMeta(id);
    if (m && m.number === n)
      return { id, number: n, content_length: m.content_length ?? 0, fee: m.fee ?? 0, content_type: m.content_type || "", height: m.height ?? 0 };
  }
  return null;
}

function nearestRank(sorted, k) { // k in 1..99
  return sorted[Math.max(0, Math.ceil((k / 100) * sorted.length) - 1)];
}

async function main() {
  mkdirSync(dirname(RESUME), { recursive: true });
  const rows = existsSync(RESUME) ? readFileSync(RESUME, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const done = new Set(rows.map((r) => r.number));
  console.log(`resume: ${rows.length} sampled already`);

  const height = Number(await (await get(`${ORD}/r/blockheight`)).text()) || 0;
  const max = await maxNumber();
  console.log(`block ${height}, max inscription number ${max}`);

  // stratified across 10 deciles of the number range, deterministic per seed
  const rng = mulberry32(SEED);
  const plan = [];
  const seen = new Set(done);
  for (let i = 0; plan.length < N - rows.length && i < N * 3; i++) {
    const d = i % 10;
    const n = Math.floor((d * max) / 10 + rng() * (max / 10));
    if (!seen.has(n)) { seen.add(n); plan.push(n); }
  }
  console.log(`sampling ${plan.length} inscriptions with ${CONC} workers…`);

  let idx = 0, ok = 0, miss = 0;
  const worker = async () => {
    while (idx < plan.length) {
      const n = plan[idx++];
      try {
        const row = await sampleOne(n);
        if (row) { rows.push(row); appendFileSync(RESUME, JSON.stringify(row) + "\n"); ok++; }
        else miss++;
      } catch (e) { miss++; console.warn(`#${n}: ${e.message}`); }
      if ((ok + miss) % 50 === 0) console.log(`  ${ok + miss}/${plan.length} (${ok} ok, ${miss} miss)`);
      await sleep(GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const col = (f) => rows.map(f).sort((a, b) => a - b);
  const lens = col((r) => r.content_length), fees = col((r) => r.fee), rates = col((r) => feeRate(r.fee, r.content_length));
  const breaks = (sorted, round) => Array.from({ length: 99 }, (_, i) => round(nearestRank(sorted, i + 1)));
  const out = {
    version: 1, builtAt: new Date().toISOString(), height, maxNumber: max, sampleSize: rows.length,
    method: "stratified-number-sample", seed: SEED,
    content_length: breaks(lens, Math.round),
    fee_rate: breaks(rates, (v) => +v.toFixed(2)),
    fee: breaks(fees, Math.round),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  const show = (name, arr) => console.log(`${name.padEnd(15)} p10 ${arr[9]}  p50 ${arr[49]}  p90 ${arr[89]}  p99 ${arr[98]}`);
  console.log(`\nwrote ${OUT} from ${rows.length} inscriptions`);
  show("content_length", out.content_length); show("fee_rate", out.fee_rate); show("fee", out.fee);
}

main().catch((e) => { console.error(e); process.exit(1); });
