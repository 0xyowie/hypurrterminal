// Generate /cat/<id> passport pages (per-cat OG unfurls + embedded data), scatter.json, sitemap-cats.xml
import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const D = p => path.join(ROOT, "data", p), S = p => path.join(ROOT, "site", p);
const traits = JSON.parse(fs.readFileSync(D("traits.json"))).tokens;
const owners = JSON.parse(fs.readFileSync(D("owners.json"))).owners;
const prov = JSON.parse(fs.readFileSync(D("provenance_all.json"))).prov;
const sales = JSON.parse(fs.readFileSync(D("sales.json"))).byToken;
fs.mkdirSync(S("cat"), { recursive: true });
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
let scatter = [];
const tpl = (t) => {
  const id = t.id, rr = t.rarityRank;
  const p = prov[id] || { trades: 0, currentOwner: owners[id] };
  const sl = (sales[id] || []).map(x => ({ t: x.ts, p: x.price }));
  const last = sl.length ? sl[sl.length-1].p : 0;
  if (last) scatter.push({ id, rr, p: last });
  const flips = p.trades || 0;
  const diamond = flips === 0;
  const ownerShort = (p.currentOwner||"").slice(0,6)+"…"+(p.currentOwner||"").slice(-4);
  const desc = `Rarity rank #${rr} of 4,600 · ${diamond ? "diamond hands — never traded" : `traded ${flips}×`}${last ? ` · last sale ${last} HYPE` : ""} · live on Hyperliquid.`;
  const DATA = JSON.stringify({ id, rr, traits: t.traits, flips, diamond, owner: p.currentOwner, sales: sl });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hypurr #${id} — rank #${rr} · Hypurr Terminal</title>
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
  <a class="brand" href="/"><img class="logo" src="/favicon.svg" alt="" width="33" height="33"><span>HYPURR</span></a>
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
<div class="lg"><a href="/privacy">Privacy</a><a href="/">Home</a></div></div></footer>
</body></html>`;
};
let n = 0;
for (const t of traits) { fs.writeFileSync(S(`cat/${t.id}.html`), tpl(t)); n++; }
fs.writeFileSync(S("data/scatter.json"), JSON.stringify({ pts: scatter }));
const sm = ['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...traits.map(t=>`<url><loc>https://hypurrterminal.xyz/cat/${t.id}</loc></url>`),'</urlset>'].join("\n");
fs.writeFileSync(S("sitemap-cats.xml"), sm);
console.log(`cat pages: ${n} · scatter pts: ${scatter.length} · sitemap-cats ${(fs.statSync(S("sitemap-cats.xml")).size/1024).toFixed(0)}KB`);
