// ORDINAL CARDS — client. One screen at a time, no explanations, only actions.

const app = document.getElementById("app");
const pid = sessionStorage.pid || (sessionStorage.pid = crypto.randomUUID());

const PERM = ["fee", "height", "number", "content_length"]; // fixed forever at inscription
const MUT = ["value", "children", "reinsc"];                // can still change on-chain
const FIELDS = [...PERM, ...MUT];
const LABEL = { fee: "FEE", height: "BLK", number: "NUM", content_length: "SIZE", value: "VAL", children: "CHLD", reinsc: "REINSC" };
const DECK_MAX = 20, DECK_MIN = 3;

let addr = sessionStorage.addr || "";
let wallet = [];      // [{id, content_type, meta?}]
let sel = [];         // selected inscription ids, in pick order
let deckTab = "wallet"; // deck-builder tab: "wallet" (all ordinals) | "deck" (selected)
let walletFailed = false;
let screen = "";
let game = null;      // last game view from server
let pick = null;      // leader's tapped hand card
let timerIv = null;

const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "?");
const fmt = (n) => {
  n = Number(n) || 0;
  if (n < 1e6) return String(n);
  if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "G";
};
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function queueUp() {
  if (sel.length < DECK_MIN) { flash(`DECK ${DECK_MIN}–${DECK_MAX}`); showDeck(); return; }
  try {
    const r = await post("/api/queue", { pid, name: short(addr), deck: sel });
    if (!r.ok) { flash(`DECK ${DECK_MIN}–${DECK_MAX}`); showDeck(); }
  } catch { flash("OFFLINE"); }
}

const INFO_PERM = [
  ["FEE", "SATS PAID TO INSCRIBE IT"],
  ["BLK", "BITCOIN BLOCK IT WAS INSCRIBED IN — LOWER = OLDER"],
  ["NUM", "INSCRIPTION NUMBER — #0 IS THE FIRST EVER"],
  ["SIZE", "CONTENT SIZE IN BYTES"],
];
const INFO_MUT = [
  ["VAL", "SATS SITTING ON ITS OUTPUT (POSTAGE)"],
  ["CHLD", "CHILD INSCRIPTIONS IT HAS"],
  ["REINSC", "REINSCRIPTIONS ON ITS SAT"],
];
function showInfo() {
  const o = el(`<div class="overlay"></div>`);
  const sh = el(`<div class="sheet"></div>`);
  const section = (title, rows) => {
    sh.appendChild(el(`<div class="ihead">${title}</div>`));
    for (const [k, txt] of rows) sh.appendChild(el(`<div class="irow"><b>${k}</b><span>${txt}</span></div>`));
  };
  section("FIXED", INFO_PERM);
  section("CAN CHANGE", INFO_MUT);
  sh.appendChild(el(`<div class="dirs">▲ HIGHEST WINS · ▼ LOWEST WINS</div>`));
  sh.onclick = (e) => e.stopPropagation();  // scrolling/tapping the sheet must not dismiss it
  o.appendChild(sh);
  o.onclick = () => o.remove();
  document.body.appendChild(o);
}

function flash(msg) {
  document.querySelectorAll(".flash").forEach((f) => f.remove());
  const f = el(`<div class="flash"></div>`);
  f.textContent = msg;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}

// ------------------------------------------------------------------ realtime

let es = null;
function startES() {
  if (es) es.close();
  es = new EventSource(`/events?pid=${pid}&name=${encodeURIComponent(short(addr))}`);
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "game") {
      if (m.phase !== "lead" || !m.youLead) pick = null; // never carry a pick across rounds
      game = m; renderGame();
    }
    else if (m.t === "queued") showQueue();
    else if (m.t === "error") { flash(m.msg); showDeck(); }
    else if (m.t === "hello" && (screen === "queue" || screen === "game")) showDeck();
  };
}

// ------------------------------------------------------------------ content

const textCache = new Map();
function thumb(card) {
  const ct = card.content_type || "";
  const t = el(`<div class="thumb"></div>`);
  if (/^image\/|^audio\/mpeg/.test(ct) && !/svg/.test(ct)) t.appendChild(el(`<img loading="lazy" src="/o/content/${card.id}">`));
  else if (/svg/.test(ct)) t.appendChild(el(`<img loading="lazy" src="/o/content/${card.id}">`));
  else if (/^text\/plain/.test(ct)) {
    const d = el(`<div class="txt"></div>`);
    t.appendChild(d);
    if (textCache.has(card.id)) d.textContent = textCache.get(card.id);
    else fetch(`/o/content/${card.id}`).then((r) => r.text()).then((s) => {
      s = s.slice(0, 80); textCache.set(card.id, s); d.textContent = s;
    }).catch(() => { d.textContent = "?"; });
  }
  else if (/^text\/html|^application\/json|^text\//.test(ct))
    t.appendChild(el(`<iframe sandbox="allow-scripts" loading="lazy" scrolling="no" src="/o/content/${card.id}"></iframe>`));
  else t.appendChild(el(`<div class="mime">${(ct.split("/")[1] || "?").slice(0, 10)}</div>`));
  return t;
}

// Numeric stats live on the card itself (game objects) or on .meta (wallet
// entries, hydrated lazily).
const statSrc = (card) => (card.fee != null ? card : card.meta || null);

function statRows(src, highlight) {
  const d = el(`<div class="stats"></div>`);
  const row = (f) => {
    const r = el(`<div class="srow ${highlight === f ? "hi" : ""}"></div>`);
    r.appendChild(el(`<span>${LABEL[f]}</span>`));
    r.appendChild(el(`<b>${src ? fmt(src[f]) : "·"}</b>`));
    d.appendChild(r);
  };
  PERM.forEach(row);
  d.appendChild(el(`<div class="sdiv"></div>`)); // fixed traits ▲ / changing traits ▼
  MUT.forEach(row);
  return d;
}

// A full card: number header, art, stat block underneath — like a real card.
// `highlight` marks one field row (the called field).
function cardEl(card, cls, highlight) {
  const d = el(`<div class="card ${cls || ""}"></div>`);
  const n = card.meta?.number ?? card.number;
  d.appendChild(el(`<div class="chead">${n != null ? "#" + n : "···"}</div>`));
  d.appendChild(thumb(card));
  d.appendChild(statRows(statSrc(card), highlight));
  return d;
}

// ------------------------------------------------------------------ screens

function show(node, name) {
  screen = name;
  clearInterval(timerIv);
  app.replaceChildren(node);
}

function showConnect() {
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  // no injected provider on a phone → hop into Xverse's in-app browser
  // (real anchor: iOS only routes universal links from a genuine user tap)
  const deep = "https://connect.xverse.app/browser?url=" + encodeURIComponent(location.href);
  const s = el(`<div class="center">
    <div class="logo">ORDINAL CARDS</div>
    <a class="btn wx" href="#">XVERSE</a>
    <button class="wu">UNISAT</button>
    <button class="wa">ADDRESS</button>
    <div class="addrbox" style="width:min(260px,80vw);display:none">
      <input placeholder="bc1…" spellcheck="false">
      <button class="wa" style="width:100%;margin-top:10px">GO</button>
    </div>
  </div>`);
  const box = s.querySelector(".addrbox");
  const wx = s.querySelector(".wx");
  wx.href = isMobile ? deep : "#";
  wx.onclick = (e) => {
    const prov = window.XverseProviders?.BitcoinProvider || window.BitcoinProvider;
    if (prov) { e.preventDefault(); connectXverse(); }
    else if (!isMobile) { e.preventDefault(); flash("NO XVERSE"); }
    // mobile without provider: let the tap follow the link into the Xverse app
  };
  s.querySelector(".wu").onclick = () => connectUnisat();
  s.querySelectorAll(".wa")[0].onclick = () => { box.style.display = "block"; box.querySelector("input").focus(); };
  const go = () => { const v = box.querySelector("input").value.trim(); if (v) setAddr(v); };
  box.querySelector("button").onclick = go;
  box.querySelector("input").onkeydown = (e) => { if (e.key === "Enter") go(); };
  show(s, "connect");
}

function logout() {
  post("/api/leave", { pid }).catch(() => { });
  if (es) { es.close(); es = null; }
  sessionStorage.clear();               // fresh identity next login
  addr = ""; wallet = []; sel = []; game = null; walletFailed = false;
  showConnect();
}

async function connectXverse() {
  try {
    const prov = window.XverseProviders?.BitcoinProvider || window.BitcoinProvider;
    if (!prov) return flash("NO XVERSE");
    const r = await prov.request("wallet_connect", null);
    const list = r?.result?.addresses || [];
    const a = (list.find((x) => x.purpose === "ordinals") || list[0])?.address;
    if (a) setAddr(a); else flash("NO ADDRESS");
  } catch { flash("REJECTED"); }
}

async function connectUnisat() {
  try {
    if (!window.unisat) return flash("NO UNISAT");
    const [a] = await window.unisat.requestAccounts();
    if (a) setAddr(a); else flash("NO ADDRESS");
  } catch { flash("REJECTED"); }
}

function restoreSel() {
  try { sel = JSON.parse(localStorage["deck:" + addr] || "[]").filter((x) => typeof x === "string"); }
  catch { sel = []; }
}

async function setAddr(a) {
  addr = a;
  sessionStorage.addr = a;
  wallet = [];
  restoreSel();
  startES();
  showDeck();
  await loadWallet();
}

async function loadWallet() {
  const forAddr = addr; // guard: the user may switch identity mid-fetch
  let list = null;
  try {
    const r = await fetch(`/api/addr/${encodeURIComponent(forAddr)}`);
    if (r.ok) list = await r.json();
  } catch { }
  if (forAddr !== addr) return;      // stale response — a newer identity took over
  walletFailed = !list;
  if (!list) { flash("WALLET FAILED"); if (screen === "deck") showDeck(); return; } // sel kept for retry
  wallet = list;
  sel = sel.filter((id) => wallet.some((c) => c.id === id));
  if (screen === "deck") showDeck();
  // hydrate numeric fields, 4 at a time, through the server cache
  const q = [...wallet];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length && forAddr === addr) {
      const c = q.shift();
      try { c.meta = await (await fetch(`/api/card/${c.id}`)).json(); } catch { }
      const host = document.querySelector(`[data-id="${c.id}"]`);
      if (host && c.meta) {
        const h = host.querySelector(".chead");
        if (h) h.textContent = "#" + c.meta.number;
        const s = host.querySelector(".stats");
        if (s) s.replaceWith(statRows(c.meta));
      }
    }
  }));
}

function showDeck() {
  game = null; pick = null;
  const s = el(`<div style="display:flex;flex-direction:column;height:100%">
    <div class="bar">
      <span class="mid"><span class="who"></span><button class="obtn">LOGOUT</button></span>
      <span class="count"></span>
      <span class="mid">
        <button class="ibtn">i</button>
        <button class="play">PLAY</button>
      </span>
    </div>
    <div class="tabs">
      <div class="tab" data-t="wallet">WALLET</div>
      <div class="tab" data-t="deck">DECK</div>
      <div class="tab clear">CLEAR</div>
    </div>
    <div class="grid"></div>
  </div>`);
  s.querySelector(".who").textContent = short(addr);
  s.querySelector(".obtn").onclick = () => logout();
  const grid = s.querySelector(".grid");
  const count = s.querySelector(".count");
  const play = s.querySelector(".play");
  const sync = () => {
    count.textContent = `${sel.length}/${DECK_MAX}`;
    play.disabled = sel.length < DECK_MIN;
    localStorage["deck:" + addr] = JSON.stringify(sel);
  };
  for (const t of s.querySelectorAll(".tab[data-t]")) {
    if (t.dataset.t === deckTab) t.classList.add("on");
    t.onclick = () => { deckTab = t.dataset.t; showDeck(); };
  }
  const clear = s.querySelector(".clear");
  clear.style.visibility = sel.length ? "visible" : "hidden";
  clear.onclick = () => { sel = []; showDeck(); };
  const cards = deckTab === "deck"
    ? sel.map((id) => wallet.find((c) => c.id === id)).filter(Boolean)
    : wallet;
  for (const c of cards) {
    const t = cardEl(c, sel.includes(c.id) ? "on" : "");
    t.dataset.id = c.id;
    if (sel.includes(c.id)) t.appendChild(el(`<div class="ord">${sel.indexOf(c.id) + 1}</div>`));
    t.onclick = () => {
      const i = sel.indexOf(c.id);
      if (i >= 0) sel.splice(i, 1);
      else if (sel.length >= DECK_MAX) return flash(`MAX ${DECK_MAX}`);
      else sel.push(c.id);
      showDeck();
    };
    grid.appendChild(t);
  }
  if (walletFailed && !wallet.length) {
    const r = el(`<button class="retry">RETRY</button>`);
    r.onclick = () => { walletFailed = false; showDeck(); loadWallet(); };
    grid.appendChild(r);
  }
  play.onclick = () => queueUp();
  s.querySelector(".ibtn").onclick = showInfo;
  sync();
  show(s, "deck");
}

function showQueue() {
  const s = el(`<div class="center">
    <div class="big pulse">···</div>
    <button>X</button>
  </div>`);
  s.querySelector("button").onclick = () => post("/api/leave", { pid });
  show(s, "queue");
}

// ------------------------------------------------------------------ game

function renderGame() {
  const v = game;
  if (!v) return;
  if (v.over) return showOver(v);

  const s = el(`<div style="display:flex;flex-direction:column;height:100%">
    <div class="gtop">
      <span><span class="dim">${esc(v.opp.name)}</span> <span class="score">${v.opp.wins}</span></span>
      <span class="mid"><span class="rnd">${v.round}/${v.totalRounds}</span><button class="ibtn">i</button></span>
      <span><span class="score">${v.you.wins}</span> <span class="dim">YOU</span></span>
    </div>
    <div class="stage"></div>
    <div class="timer"><i></i></div>
    <div class="handwrap"><div class="hand"></div><div class="hint"></div></div>
  </div>`);
  const stage = s.querySelector(".stage");
  const hand = s.querySelector(".hand");
  const hint = s.querySelector(".hint");
  s.querySelector(".gtop .ibtn").onclick = showInfo;

  const myTurn = (v.phase === "lead" && v.youLead) || (v.phase === "follow" && !v.youLead);

  // ---- stage
  if (v.phase === "reveal") {
    const r = v.reveal;
    const side = (card, val, who, win) => {
      const d = el(`<div class="side ${win === "tie" ? "" : win ? "win" : "lose"}"></div>`);
      d.appendChild(el(`<div class="tag">${esc(who)}</div>`));
      d.appendChild(cardEl(card, "", r.field));
      d.appendChild(el(`<div class="val">${fmt(card[r.field])}</div>`));
      return d;
    };
    stage.appendChild(el(`<div class="callout">${LABEL[r.field]} <span class="arrow">${r.dir === "high" ? "▲" : "▼"}</span></div>`));
    const duel = el(`<div class="duel"></div>`);
    duel.appendChild(side(r.yourCard, 0, "YOU", r.winner === "tie" ? "tie" : r.winner === "you"));
    duel.appendChild(side(r.oppCard, 0, v.opp.name, r.winner === "tie" ? "tie" : r.winner === "opp"));
    stage.appendChild(duel);
    stage.appendChild(el(`<div class="dim">${r.winner === "tie" ? "TIE" : r.winner === "you" ? "+1 YOU" : "+1 " + esc(v.opp.name)}</div>`));
  } else if (v.phase === "lead" && v.youLead) {
    if (pick) {
      const card = v.you.hand.find((c) => c.id === pick);
      if (card) {
        const bc = el(`<div class="minicard"></div>`);
        bc.appendChild(thumb(card));
        stage.appendChild(bc);
        const rows = el(`<div class="frows"></div>`);
        for (const f of FIELDS) {
          if (f === MUT[0]) rows.appendChild(el(`<div class="fdiv"></div>`));
          const row = el(`<div class="frow"><span class="fl">${LABEL[f]}</span><span class="fv">${fmt(card[f])}</span></div>`);
          for (const dir of ["high", "low"]) {
            const b = el(`<button>${dir === "high" ? "▲" : "▼"}</button>`);
            b.onclick = () => { post("/api/play", { pid, cardId: card.id, field: f, dir }); pick = null; };
            row.appendChild(b);
          }
          rows.appendChild(row);
        }
        stage.appendChild(rows);
      }
    } else stage.appendChild(el(`<div class="wait pulse">▼</div>`));
  } else if (v.phase === "follow" && !v.youLead) {
    stage.appendChild(el(`<div class="callout">${LABEL[v.lead.field]} <span class="arrow">${v.lead.dir === "high" ? "▲" : "▼"}</span></div>`));
  } else if (v.phase === "follow" && v.youLead) {
    const card = v.you.hand.find((c) => c.id === v.lead.cardId);
    if (card) { const bc = el(`<div class="minicard"></div>`); bc.appendChild(thumb(card)); stage.appendChild(bc); }
    stage.appendChild(el(`<div class="callout">${LABEL[v.lead.field]} <span class="arrow">${v.lead.dir === "high" ? "▲" : "▼"}</span></div>`));
    stage.appendChild(el(`<div class="wait pulse">···</div>`));
  } else {
    stage.appendChild(el(`<div class="wait pulse">···</div>`));
  }

  // ---- hand
  for (const c of v.you.hand) {
    const held = v.phase === "follow" && v.youLead && c.id === v.lead.cardId;
    const called = v.phase === "follow" && !v.youLead ? v.lead.field : null;
    const t = cardEl(c, (pick === c.id ? "pick" : "") + (held ? " pick" : ""), called);
    t.onclick = () => {
      if (v.phase === "lead" && v.youLead) { pick = pick === c.id ? null : c.id; renderGame(); }
      else if (v.phase === "follow" && !v.youLead) post("/api/play", { pid, cardId: c.id });
    };
    hand.appendChild(t);
  }
  hint.textContent = myTurn ? (v.phase === "lead" ? (pick ? "" : "PICK CARD") : "PICK CARD") : "";

  // ---- timer
  const bar = s.querySelector(".timer i");
  if (v.deadline && myTurn) {
    const total = Math.max(1, v.deadline - Date.now());
    const tick = () => {
      const left = Math.max(0, v.deadline - Date.now());
      bar.style.width = (left / total * 100) + "%";
    };
    tick();
    show(s, "game");
    timerIv = setInterval(tick, 250);
    return;
  }
  bar.style.width = "0";
  show(s, "game");
}

function showOver(v) {
  const word = v.over.result === "win" ? "WIN" : v.over.result === "lose" ? "LOSE" : "DRAW";
  const cls = { win: "w", lose: "l", draw: "d" }[v.over.result];
  const s = el(`<div class="center over">
    <div class="big ${cls}">${word}</div>
    <div class="result-score">${v.over.you} — ${v.over.opp}${v.over.forfeit ? " ✕" : ""}</div>
    <div class="rowbtns">
      <button class="again">PLAY</button>
      <button class="exit">EXIT</button>
    </div>
  </div>`);
  s.querySelector(".again").onclick = () => queueUp();
  s.querySelector(".exit").onclick = () => showDeck();
  show(s, "over");
}

// ------------------------------------------------------------------ boot

// iOS WebKit only fires :active on touch when a touchstart listener exists
document.addEventListener("touchstart", () => { }, { passive: true });

if (addr) { restoreSel(); startES(); showDeck(); loadWallet(); }
else showConnect();
