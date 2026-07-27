// Generate /cat/<id> passport pages (per-cat OG unfurls + embedded data) and sitemap-cats.xml
//
// Two rules this script has to respect:
//
//  1. Read live state from site/data/, never from data/. data/ is the frozen July
//     snapshot used to bootstrap the site; building 4,600 pages from it bakes in
//     months-old owners and sale prices.
//  2. The OG description must be STABLE. These pages are regenerated rarely, so any
//     volatile fact baked into <meta> (last sale price, trade count) is stale on a
//     crawler's next visit and there is no JavaScript to repair it. Volatile facts
//     belong in the visible page, where passport.js refreshes them on load.
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
// fileURLToPath, not url.pathname: a pathname keeps its percent-encoding, so a
// checkout under a folder with a space in it resolves to "Perps%20trading" and every
// read fails with ENOENT. The CI runner has no spaces in its path and never saw this.
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const D = p => path.join(ROOT, "data", p), S = p => path.join(ROOT, "site", p);
const traits = JSON.parse(fs.readFileSync(D("traits.json"))).tokens;   // static metadata
const owners = JSON.parse(fs.readFileSync(S("data/owners.json")));      // {id: owner}
const prov = JSON.parse(fs.readFileSync(S("data/provenance.json"))).prov;
const sales = JSON.parse(fs.readFileSync(S("data/sales.json"))).byToken;
fs.mkdirSync(S("cat"), { recursive: true });
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
const tpl = (t) => {
  const id = t.id, rr = t.rarityRank;
  const p = prov[id] || { trades: 0, currentOwner: owners[id] };
  const sl = (sales[id] || []).map(x => ({ t: x.ts, p: x.price }));
  const last = sl.length ? sl[sl.length-1].p : 0;
  const flips = p.trades || 0;
  const diamond = flips === 0;
  const ownerShort = (p.currentOwner||"").slice(0,6)+"…"+(p.currentOwner||"").slice(-4);
  // Stable by construction: rarity rank and trait count never change. No price, no
  // trade count, nothing that goes stale between regenerations of these 4,600 pages.
  const traitCount = Object.keys(t.traits || {}).length;
  const desc = `Hypurr #${id}, rarity rank #${rr} of 4,600, ${traitCount} traits. Owner wallet, full sale history and live Hyperliquid positioning, updated every cycle.`;
  const DATA = JSON.stringify({ id, rr, traits: t.traits, flips, diamond, owner: p.currentOwner, sales: sl });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hypurr #${id} · rank #${rr} · Hypurr Terminal</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0E0B08">
<meta property="og:type" content="website"><meta property="og:url" content="https://hypurrterminal.xyz/cat/${id}">
<meta property="og:title" content="Hypurr #${id} · rank #${rr}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://hypurrterminal.xyz/img/${id}.webp">
<meta name="twitter:card" content="summary"><meta name="twitter:image" content="https://hypurrterminal.xyz/img/${id}.webp">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" sizes="48x48" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/base.css"><script src="/assets/app.js"></script>
<link rel="stylesheet" href="/assets/passport.css"><script defer src="/assets/passport.js"></script>
<script>window.CAT=${DATA};</script>
</head><body data-page="cat">
<header class="site"><div class="bar">
  <a class="brand" href="/"><img class="logo" src="/favicon.svg" alt="" width="33" height="33"><span>HYPURR<em class="tm">TERMINAL</em></span></a>
  <nav class="top">
    <a href="/collection" data-nav="collection">The Collection</a>
    <a href="/positioning" data-nav="positioning">The Index</a>
    <a href="/desk" data-nav="desk">Live Desk</a>
    <a href="/pride" data-nav="pride">The Pride</a>
  </nav>
</div></header>
<div class="wrap pass">
  <div class="pcard">
    <div class="part"><img src="/img/${id}.webp" alt="Hypurr #${id}" width="400" height="400"></div>
    <div class="pmeta">
      <div class="kicker">Passport · Hypurr Terminal</div>
      <h1 class="disp">Hypurr #${id}</h1>
      <div class="chips">
        <span class="chip">rarity <b>#${rr}</b></span>
        <span class="chip" id="stance"><i class="sdot"></i>checking the tape…</span>
        ${diamond ? '<span class="chip dia">💎 never traded</span>' : `<span class="chip fire">🔥 traded ${flips}×</span>`}
        ${last ? `<span class="chip gold">last sale <b>${last} HYPE</b></span>` : ""}
      </div>
      <div class="ownerline">held by <code>${ownerShort}</code> <span class="stale">(at last index)</span></div>
      <div class="actions">
        <button class="btn" id="shareBtn">Share passport ↗</button>
        <button class="btn ghost" id="copyBtn">Copy link</button>
        <a class="btn ghost" href="/collection?q=${id}">Open in Collection</a>
      </div>
    </div>
  </div>
  <div class="traitsbox"><h3>Traits</h3><div class="tgrid" id="tgrid"></div></div>
  <div class="salebox" id="salebox"></div>
</div>
<canvas id="pp" width="1000" height="1250" hidden></canvas>
<footer class="site"><div class="foot">Direction and size only, never PnL. Unofficial community tool.
<div class="lg"><a href="/privacy">Privacy</a><a href="/">Home</a><a href="https://x.com/intent/user?screen_name=0xYowie" target="_blank" rel="noopener">made by @0xyowie ↗</a></div></div></footer>
</body></html>`;
};
let n = 0;
for (const t of traits) { fs.writeFileSync(S(`cat/${t.id}.html`), tpl(t)); n++; }
// scatter.json is NOT written here. It is derived from sale prices, so it belongs to
// the cron (refresh-prod.mjs), which rebuilds it on every scan that finds a sale.
// Writing it from this script froze the chart at whenever the pages were last built.
const sm = ['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...traits.map(t=>`<url><loc>https://hypurrterminal.xyz/cat/${t.id}</loc></url>`),'</urlset>'].join("\n");
fs.writeFileSync(S("sitemap-cats.xml"), sm);
console.log(`cat pages: ${n} · sitemap-cats ${(fs.statSync(S("sitemap-cats.xml")).size/1024).toFixed(0)}KB`);
