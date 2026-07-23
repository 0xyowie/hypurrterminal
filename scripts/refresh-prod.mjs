// Refresh DYNAMIC production data into site/data/: positions.json, index.json, desk.json.
// Run on a schedule (GitHub Actions). NO PnL fields, ever.
import fs from "node:fs";
import path from "node:path";
const INFO = "https://api.hyperliquid.xyz/info"; // Hyperliquid public info API (no deps needed)
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const D = path.join(ROOT, "data");
const OUT = path.join(ROOT, "site/data");
fs.mkdirSync(OUT, { recursive: true });
const wallets = JSON.parse(fs.readFileSync(path.join(D, "wallets.json"))).wallets;
const addrs = Object.keys(wallets);
const ownersRaw = JSON.parse(fs.readFileSync(path.join(D, "owners.json"))).owners; // {id:owner}
const traits = JSON.parse(fs.readFileSync(path.join(D, "traits.json"))).tokens;
const rrOf = {}, nameKnown = {}; traits.forEach(t => { rrOf[t.id] = t.rarityRank; });
const heldBy = {}; for (const id in ownersRaw){ (heldBy[ownersRaw[id]] ||= []).push(+id); }

const FORBIDDEN = ["unrealizedPnl", "returnOnEquity", "entryPx", "liquidationPx"];
async function clearinghouse(addr, tries = 4){
  for (let a=0;a<tries;a++){ try {
    const r = await fetch(INFO, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ type:"clearinghouseState", user: addr }), signal: AbortSignal.timeout(15000) });
    if (r.status===429){ await new Promise(s=>setTimeout(s,800*(a+1))); continue; }
    if (!r.ok){ await new Promise(s=>setTimeout(s,400*(a+1))); continue; }
    return await r.json();
  } catch { await new Promise(s=>setTimeout(s,400*(a+1))); } }
  return null;
}
async function pool(items, worker, c, onp){ let i=0,d=0; async function run(){ while(i<items.length){ const my=i++; await worker(items[my]); d++; if(onp&&d%300===0)onp(d,items.length);} } await Promise.all(Array.from({length:c},run)); }

const positions = {}; let errors = 0;
await pool(addrs, async (addr) => {
  const j = await clearinghouse(addr);
  if (!j){ errors++; positions[addr] = { hasPosition:false, positions:[], error:true }; return; }
  const ps = (j.assetPositions||[]).map(p => { const pos = p.position||{};
    return { coin: pos.coin, direction: Number(pos.szi)>=0?"long":"short",
      size: Math.abs(Number(pos.szi)||0), notionalUsd: Math.round(Number(pos.positionValue)||0),
      leverage: pos.leverage ? { type: pos.leverage.type, value: pos.leverage.value } : null }; })
    .filter(p => p.notionalUsd >= 10);   // drop dust legs — a "$0 long" is noise, and a dust-only wallet isn't "awake"
  positions[addr] = { hasPosition: ps.length>0, positions: ps };
}, 15, (d,t)=>process.stdout.write(`positions ${d}/${t} (err ${errors})\r`));

// Guard: a degraded sweep (rate-limited / network trouble) marks failed wallets "flat".
// Better to fail the run and keep yesterday's data than to commit a half-empty snapshot.
if (errors > addrs.length * 0.05){
  console.error(`FATAL: ${errors}/${addrs.length} wallets failed to fetch — refusing to write a degraded snapshot.`);
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const posOut = JSON.stringify({ generatedAt, source:"clearinghouseState", wallets: positions });
if (FORBIDDEN.some(k => posOut.includes(k))){ console.error("FATAL: forbidden PnL key"); process.exit(1); }
fs.writeFileSync(path.join(OUT, "positions.json"), posOut);

// ---- aggregate index ----
const holdersTotal = addrs.length;
let holdersWithPosition=0, longNotional=0, shortNotional=0, longCount=0, shortCount=0, walletsNetLong=0, walletsNetShort=0, walletsNetFlat=0;
const coins = {};
for (const [addr,w] of Object.entries(positions)){
  if (!w.hasPosition) continue; holdersWithPosition++; let net=0;
  for (const p of w.positions){
    if (p.direction==="long"){ longNotional+=p.notionalUsd; longCount++; net+=p.notionalUsd; }
    else { shortNotional+=p.notionalUsd; shortCount++; net-=p.notionalUsd; }
    (coins[p.coin] ||= { longNotional:0, shortNotional:0, longWallets:new Set(), shortWallets:new Set() });
    if (p.direction==="long"){ coins[p.coin].longNotional+=p.notionalUsd; coins[p.coin].longWallets.add(addr); }
    else { coins[p.coin].shortNotional+=p.notionalUsd; coins[p.coin].shortWallets.add(addr); }
  }
  if (net>0) walletsNetLong++; else if (net<0) walletsNetShort++; else walletsNetFlat++;
}
const topCoins = Object.entries(coins).map(([coin,c]) => ({ coin,
  holders: new Set([...c.longWallets, ...c.shortWallets]).size,
  longWallets: c.longWallets.size, shortWallets: c.shortWallets.size,
  longNotional: Math.round(c.longNotional), shortNotional: Math.round(c.shortNotional),
  netDir: c.longNotional>=c.shortNotional?"long":"short",
})).sort((a,b)=>(b.longNotional+b.shortNotional)-(a.longNotional+a.shortNotional)).slice(0,15);
const index = { generatedAt, holdersTotal, holdersWithPosition,
  participationRate:+(holdersWithPosition/holdersTotal).toFixed(4),
  byWallet:{ netLong:walletsNetLong, netShort:walletsNetShort, netFlat:walletsNetFlat },
  byNotional:{ longNotional:Math.round(longNotional), shortNotional:Math.round(shortNotional), longPct:+(longNotional/Math.max(1,longNotional+shortNotional)).toFixed(4) },
  byPositionCount:{ longCount, shortCount }, topCoins };
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index));

// ---- desk.json : top trading holders (join owners+traits) ----
const rows = [];
for (const [owner, w] of Object.entries(positions)){
  if (!w.hasPosition) continue;
  const held = heldBy[owner]; if (!held || !held.length) continue; // must hold a Hypurr
  const rep = held.slice().sort((a,b)=> rrOf[a]-rrOf[b])[0];       // rarest held
  const pos = w.positions.slice().sort((a,b)=> b.notionalUsd-a.notionalUsd);
  const totalNotional = pos.reduce((s,p)=> s+p.notionalUsd, 0);
  const netNotional = pos.reduce((s,p)=> s+(p.direction==="long"?1:-1)*p.notionalUsd, 0); // full book, not just the top-12 slice
  rows.push({ owner, id: rep, rarityRank: rrOf[rep], heldCount: held.length, totalNotional, netNotional,
    positions: pos.slice(0, 12), posCount: pos.length });
}
rows.sort((a,b)=> b.totalNotional - a.totalNotional);
fs.writeFileSync(path.join(OUT, "desk.json"), JSON.stringify({ generatedAt, holdersWithPosition, rows: rows.slice(0, 200) }));

// ---- history.json : rolling sentiment history for The Pulse (append, cap ~90 days) ----
try {
  const HFILE = path.join(OUT, "history.json");
  let hist = []; try { hist = JSON.parse(fs.readFileSync(HFILE)).points || []; } catch {}
  hist.push({ t: Math.floor(Date.now()/1000),
    nl: walletsNetLong, ns: walletsNetShort, live: holdersWithPosition,
    lp: +(longNotional/Math.max(1,longNotional+shortNotional)).toFixed(4),
    ln: Math.round(longNotional), sn: Math.round(shortNotional) });
  if (hist.length > 8800) hist = hist.slice(hist.length - 8800);
  fs.writeFileSync(HFILE, JSON.stringify({ updated: generatedAt, points: hist }));
} catch (e) { console.error("history:", e.message); }

// ---- hype_price.json : HYPE candles for the Pulse overlay ----
// daily for the long arc, hourly for the young-terminal window (the chart picks by span)
try {
  const now = Date.now();
  async function candles(interval, days){
    const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: "HYPE", interval, startTime: now - days*86400e3, endTime: now } }),
      signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j.map(c => ({ t: Math.floor(c.t/1000), c: +c.c })) : null;
  }
  const px = await candles("1d", 120);
  const pxh = await candles("1h", 14);
  if (px) fs.writeFileSync(path.join(OUT, "hype_price.json"), JSON.stringify({ updated: generatedAt, px, pxh: pxh||[] }));
} catch (e) { console.error("hype price:", e.message); }

// ---- leaders.json : leaderboards for The Pulse ----
try {
  const boards = { updated: generatedAt };
  boards.biggest = rows.slice(0, 10).map(r => ({ owner: r.owner, id: r.id, notional: r.totalNotional, coins: r.posCount }));
  boards.diversified = rows.slice().sort((a,b)=> (b.posCount||0)-(a.posCount||0)).slice(0,10)
    .map(r => ({ owner: r.owner, id: r.id, coins: r.posCount, notional: r.totalNotional }));
  const crowdLong = walletsNetLong >= walletsNetShort;
  boards.contrarians = rows.filter(r => crowdLong ? r.netNotional < 0 : r.netNotional > 0)
    .slice(0, 10).map(r => ({ owner: r.owner, id: r.id, notional: r.totalNotional }));
  boards.crowd = crowdLong ? "long" : "short";
  fs.writeFileSync(path.join(OUT, "leaders.json"), JSON.stringify(boards));
} catch (e) { console.error("leaders:", e.message); }

// ---- cat_states.json : per-cat live stance for the living hero (0 flat / 1 long / 2 short) ----
let states = "";
for (let id = 1; id <= 4600; id++) {
  const owner = ownersRaw[id]; const w = owner ? positions[owner] : null;
  if (!w || !w.hasPosition) { states += "0"; continue; }
  let net = 0; for (const p of w.positions) net += (p.direction === "long" ? 1 : -1) * p.notionalUsd;
  states += net >= 0 ? "1" : "2";
}
fs.writeFileSync(path.join(OUT, "cat_states.json"), JSON.stringify({ generatedAt, states }));

console.log(`\nholders ${holdersTotal}, live ${holdersWithPosition} (${(index.participationRate*100).toFixed(1)}%), errors ${errors}`);
console.log(`net-long wallets ${walletsNetLong}, net-short ${walletsNetShort}; long by notional ${(index.byNotional.longPct*100).toFixed(1)}%`);
console.log(`desk rows ${Math.min(200,rows.length)} (of ${rows.length} trading holders)`);
