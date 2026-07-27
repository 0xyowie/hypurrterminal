// Refresh production data into site/data/. NO PnL fields, ever.
// Phase 1 (chain): incremental on-chain log scan -> current ownership, provenance
//   (trade history) and sales, extending the committed snapshots. Pure fetch, no deps.
// Phase 2 (positions): live Hyperliquid perp positioning for the CURRENT holders.
import fs from "node:fs";
import path from "node:path";
import { priceForLeg as priceLeg, DUST as DUST_HYPE } from "./sale-price.mjs";
import { makePool, pmap } from "./rpc-pool.mjs";

const INFO = "https://api.hyperliquid.xyz/info";     // Hyperliquid public info API
// HyperEVM JSON-RPC: see scripts/rpc-pool.mjs. The pool tracks endpoint health and
// parks whichever one is rate-limiting, which matters here because the official node
// throttles hard and then times out for minutes. Every node caps eth_getLogs at 1000
// blocks, so the scan still runs in 1000-block windows.
const NFT  = "0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const WHYPE = "0x5555555555555555555555555555555555555555";
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DIST = "0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610"; // airdrop distributor
const SUPPLY = 4600;
const CHAIN_ID = 999;
const GENESIS_BLOCK = 40876211; // first ownership snapshot block (fallback scan floor)

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const D = path.join(ROOT, "data");        // static inputs (traits)
const OUT = path.join(ROOT, "site/data"); // outputs + prior state
fs.mkdirSync(OUT, { recursive: true });
const rd = f => JSON.parse(fs.readFileSync(f));
const readOut = f => { try { return rd(path.join(OUT, f)); } catch { return null; } };
const hex = n => "0x" + n.toString(16);

const traits = rd(path.join(D, "traits.json")).tokens;
const rrOf = {}; traits.forEach(t => { rrOf[t.id] = t.rarityRank; });

// ---- JSON-RPC helpers ----
const rpcPool = makePool();
// Soft call: returns the result, or null once every endpoint has been tried. A `null`
// RESULT from a node (which is how a pruned node says "I don't have that transaction")
// is not accepted as an answer; the pool asks somebody else.
const rpc = (method, params) => rpcPool.soft(method, params, { tries: 8 });
// eth_getLogs for a block window; throws if it can't be fetched (so caller can bail safely)
async function getLogsRange(from, to) {
  const l = await rpcPool.call("eth_getLogs",
    [{ address: NFT, topics: [XFER], fromBlock: hex(from), toBlock: hex(to) }], { tries: 12 });
  if (!Array.isArray(l)) throw new Error(`eth_getLogs ${from}-${to} returned no array`);
  return l;
}

// =====================================================================
// PHASE 1 — chain refresh: ownership + provenance + sales (fail-safe)
// =====================================================================
// Base state (committed snapshots we extend). owners.json carries the block
// it is accurate to; we scan Transfer logs from there to chain head.
const ownersRawFile = readOut("owners.json") || rd(path.join(D, "owners.json")).owners;
const owners = Object.assign({}, ownersRawFile.owners || ownersRawFile); // bare {id: addr} map the site reads
// Scan floor. chainstate.json is written on EVERY successful scan, including quiet
// ones, so the eth_getLogs window can never grow without bound. provenance.lastBlock
// is the legacy fallback for the first run after this change.
let ownersBlock = (readOut("chainstate.json") || {}).lastBlock
  || (readOut("provenance.json") || {}).lastBlock
  || GENESIS_BLOCK;
let ownersChanged = false;
let chainOK = false;

try {
  const headHex = await rpc("eth_blockNumber", []);
  const head = headHex ? parseInt(headHex, 16) : NaN;
  if (!Number.isFinite(head)) throw new Error("no head block");
  const fromB = ownersBlock + 1;

  // pull all Transfer logs since the snapshot, in 1000-block windows (official RPC cap),
  // scanned concurrently across endpoints. First run backfills ~months; later runs are tiny.
  let logs = [];
  if (head >= fromB) {
    const ranges = [];
    for (let f = fromB; f <= head; f += 1000) ranges.push([f, Math.min(f + 999, head)]);
    const parts = await pmap(ranges, ([f, t]) => getLogsRange(f, t), 6);
    logs = parts.flat();
  }
  const allXfers = logs.map(l => ({
    id: parseInt(l.topics[3], 16),
    from: ("0x" + l.topics[1].slice(26)).toLowerCase(),
    to:   ("0x" + l.topics[2].slice(26)).toLowerCase(),
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
    li: parseInt(l.logIndex, 16),
  })).sort((a, b) => a.block - b.block || a.li - b.li);

  // block timestamps for the (few) new blocks
  const blks = [...new Set(allXfers.map(x => x.block))];
  const tsMap = {};
  await pmap(blks, async (n) => { const b = await rpc("eth_getBlockByNumber", [hex(n), false]);
    if (b && b.timestamp) tsMap[n] = parseInt(b.timestamp, 16); }, 8);
  const nowS = Math.floor(Date.now() / 1000);

  // ---- fetch everything the window needs BEFORE deciding how far the run gets ----
  // Envelopes and receipts are fetched here, ahead of the effective-head decision, so
  // that a transaction we could not read can defer its block instead of quietly losing
  // the sale. This scan window is never revisited: the floor moves past it, so a sale
  // dropped here is dropped forever.
  const allTradeXfers = allXfers.filter(x => x.from !== ZERO && x.from !== DIST);
  const allByTx = {}; for (const t of allTradeXfers) (allByTx[t.tx] ||= []).push(t);
  const allTxHashes = Object.keys(allByTx);
  const txInfo = {};
  await pmap(allTxHashes, async (h) => { const tx = await rpc("eth_getTransactionByHash", [h]);
    if (tx) txInfo[h] = { to: (tx.to || "").toLowerCase(), val: tx.value || "0x0" }; }, 8);
  const needRc = allTxHashes.filter(h => { const tx = txInfo[h]; if (!tx) return false;
    const val = Number(BigInt(tx.val)) / 1e18; return !(val > 0.001) && tx.to !== NFT; });
  // Keep the payer on every WHYPE leg. A Seaport bulk-fulfil carries several
  // independent buyers in one tx, so "the biggest leg" is not "the price".
  const rcInfo = {};
  await pmap(needRc, async (h) => { const rc = await rpc("eth_getTransactionReceipt", [h]);
    if (rc && rc.logs) { const w = [];
      for (const e of rc.logs) { if (e.topics[0] === XFER && e.topics.length === 3 && e.address.toLowerCase() === WHYPE) {
        w.push({ from: ("0x" + e.topics[1].slice(26)).toLowerCase(), amt: Number(BigInt(e.data)) / 1e18 }); } }
      rcInfo[h] = { w }; } }, 8);

  // A missing timestamp used to be papered over with Date.now(), stamping a hop or a
  // sale with the wrong date forever. Instead, stop the run just below the first block
  // we could not read fully and leave the rest for the next cycle. Provenance appends
  // hops, so the floor MUST move in lockstep with what we actually applied.
  const badBlocks = new Set(blks.filter(n => tsMap[n] === undefined));
  let unreadableTx = 0;
  for (const h of allTxHashes) {
    const gotTx = !!txInfo[h];
    const gotRc = !needRc.includes(h) || !!rcInfo[h];
    if (gotTx && gotRc) continue;
    unreadableTx++;
    for (const it of allByTx[h]) badBlocks.add(it.block);
  }
  const missing = [...badBlocks].sort((a, b) => a - b);
  const effHead = missing.length ? missing[0] - 1 : head;
  const xfers = missing.length ? allXfers.filter(x => x.block <= effHead) : allXfers;
  if (missing.length) console.warn(`chain: block ${missing[0]} unreadable (${unreadableTx} tx, ${blks.filter(n => tsMap[n] === undefined).length} timestamps), deferring ${allXfers.length - xfers.length} transfers to the next run`);
  const tsOf = bk => tsMap[bk];

  // apply ownership deltas (authoritative: latest transfer wins)
  for (const x of xfers) { if (x.id >= 1 && x.id <= SUPPLY) { owners[x.id] = x.to; ownersChanged = true; } }

  // ---- provenance: append new hops, bump trade counts ----
  const provBase = readOut("provenance.json") || { prov: {} };
  const prov = provBase.prov || {};
  for (const x of xfers) {
    const p = prov[x.id]; if (!p) continue;
    const kind = x.from === ZERO ? "mint" : x.from === DIST ? "airdrop" : "trade";
    p.chain = p.chain || [];
    p.chain.push({ owner: x.to, ts: tsOf(x.block), kind });
    p.currentOwner = x.to;
    if (kind === "trade") p.trades = (p.trades || 0) + 1;
  }
  // reconcile currentOwner with the applied ownership map
  for (const id in prov) { if (owners[id]) prov[id].currentOwner = owners[id]; }

  // ---- sales: price the new trade txs (native HYPE, else WHYPE from receipt) ----
  const salesBase = readOut("sales.json") || { byToken: {} };
  const byToken = salesBase.byToken || {};
  const tradeXfers = xfers.filter(x => x.from !== ZERO && x.from !== DIST);
  const byTx = {}; for (const t of tradeXfers) (byTx[t.tx] ||= []).push(t);
  const txHashes = Object.keys(byTx);
  for (const h of txHashes) {
    const items = byTx[h];
    for (const it of items) {
      const per = priceLeg(it, items, txInfo[h], (rcInfo[h] || {}).w, NFT);
      if (per == null || per < DUST_HYPE) continue;
      (byToken[it.id] ||= []).push({ ts: tsOf(it.block), price: Math.round(per * 100) / 100 });
    }
  }
  for (const id in byToken) byToken[id].sort((a, b) => a.ts - b.ts);

  const generatedAt = new Date().toISOString();

  // The scan floor moves on EVERY successful scan, transfers or not. When this lived
  // in provenance.json (written only when xfers>0) a quiet stretch left the floor
  // parked, so each run rescanned the same window plus the new blocks. HyperEVM makes
  // ~86k blocks a day, so the window grows until eth_getLogs starts failing, the whole
  // chain phase is skipped by the outer catch, and ownership freezes silently.
  fs.writeFileSync(path.join(OUT, "chainstate.json"),
    JSON.stringify({ lastBlock: effHead, scannedAt: generatedAt, transfers: xfers.length }));

  // write the heavy chain outputs only when something actually moved (avoid re-committing 2MB every run)
  if (xfers.length > 0) {
    // sales stats
    const flat = []; for (const id in byToken) for (const s of byToken[id]) flat.push({ id: +id, hype: s.price, ts: s.ts });
    flat.sort((a, b) => a.hype - b.hype);
    const recent = flat.slice().sort((a, b) => b.ts - a.ts);
    const totalHype = flat.reduce((s, x) => s + x.hype, 0);
    const stats = { totalSales: flat.length, totalVolumeHype: Math.round(totalHype),
      avgPriceHype: Math.round(totalHype / Math.max(1, flat.length)),
      minPriceHype: flat.length ? Math.round(flat[0].hype) : null,
      maxPriceHype: flat.length ? Math.round(flat[flat.length - 1].hype) : null,
      maxSale: flat.length ? { id: flat[flat.length - 1].id, hype: Math.round(flat[flat.length - 1].hype) } : null,
      lastSaleTs: recent[0]?.ts || null, tokensWithSale: Object.keys(byToken).length,
      currencyNote: salesBase.stats?.currencyNote || "HYPE + WHYPE, reconstructed from on-chain payments across all marketplaces" };
    fs.writeFileSync(path.join(OUT, "provenance.json"), JSON.stringify({ nowTs: nowS, lastBlock: effHead, distributor: DIST, prov }));
    fs.writeFileSync(path.join(OUT, "sales.json"), JSON.stringify({ generatedAt, stats, byToken }));
    // compact per-token trade counts so the 4,600 static passports can show a live
    // "traded N×" / "never traded" without downloading the 2MB provenance file
    const flipsMap = {}; for (const id in prov) flipsMap[id] = prov[id].trades || 0;
    fs.writeFileSync(path.join(OUT, "flips.json"), JSON.stringify({ updated: generatedAt, flips: flipsMap }));
    // rarity-vs-price scatter for The Index. This used to be written by gen-cats.mjs
    // from the frozen data/ folder, so it never moved and drifted up to 22x off.
    writeScatter(byToken, generatedAt);
    // refresh The Pride (diamonds are never-traded tokens) so it stays consistent
    try { rebuildPride(prov, generatedAt); } catch (e) { console.error("pride:", e.message); }
  }

  // rewrite the ownership map (bare {id:addr}, the shape the site reads) when it changed
  if (ownersChanged) {
    fs.writeFileSync(path.join(OUT, "owners.json"), JSON.stringify(owners));
  }
  ownersBlock = effHead;
  chainOK = true;
  console.log(`chain: scanned ${fromB}->${effHead}, ${xfers.length} transfers applied, ${txHashes.length} trade txs`);
} catch (e) {
  console.error(`chain refresh failed (keeping last-known ownership @${ownersBlock}):`, e.message);
}

// Rarity-vs-price scatter for /positioning: one point per token that has ever sold,
// carrying its most recent price. Derived from live sales, so it moves with the cron.
function writeScatter(byToken, generatedAt) {
  const pts = [];
  for (const id in byToken) {
    const h = byToken[id]; if (!h || !h.length) continue;
    const last = h[h.length - 1].price;
    if (!(last > 0)) continue;
    pts.push({ id: +id, rr: rrOf[id], p: last });
  }
  pts.sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(OUT, "scatter.json"), JSON.stringify({ updated: generatedAt, pts }));
}

// The Pride rebuild (diamonds = never-traded tokens, grouped by holder)
function rebuildPride(prov, generatedAt) {
  const heldBy = {}; for (const id in owners) (heldBy[owners[id]] ||= []).push(+id);
  const neverByOwner = {}; let neverTraded = 0, totalTrades = 0;
  for (const id in prov) { const p = prov[id]; totalTrades += (p.trades || 0);
    if ((p.trades || 0) === 0) { neverTraded++; (neverByOwner[p.currentOwner] ||= []).push(+id); } }
  const diamonds = [];
  for (const owner in neverByOwner) for (const id of neverByOwner[owner])
    diamonds.push({ id, rarityRank: rrOf[id], owner, heldCount: (heldBy[owner] || []).length });
  diamonds.sort((a, b) => a.rarityRank - b.rarityRank);
  const flipped = Object.keys(prov).map(id => ({ id: +id, flips: prov[id].trades || 0, rarityRank: rrOf[id], owner: prov[id].currentOwner }))
    .sort((a, b) => b.flips - a.flips || a.rarityRank - b.rarityRank).slice(0, 90);
  const prevOg = readOut("og.json") || {};
  const airdropTs = prov["1"]?.airdropTs || 1759074300;
  // recomputed from the provenance chains rather than frozen at a hardcoded 18928
  let totalTransfers = 0;
  for (const id in prov) totalTransfers += (prov[id].chain || []).length;
  const og = {
    stats: {
      supply: SUPPLY, diamondWallets: Object.keys(neverByOwner).length, neverTraded, tradedCats: SUPPLY - neverTraded,
      totalTrades, totalTransfers: totalTransfers || prevOg.stats?.totalTransfers || 18928,
      mostFlipped: flipped.length ? { id: flipped[0].id, flips: flipped[0].flips } : { id: null, flips: 0 },
      airdropDate: new Date(airdropTs * 1000).toISOString().slice(0, 10),
      daysSinceAirdrop: Math.floor((Date.now() / 1000 - airdropTs) / 86400),
    }, diamonds, flipped,
  };
  fs.writeFileSync(path.join(OUT, "og.json"), JSON.stringify(og));
}

// =====================================================================
// PHASE 2 — live positions for the CURRENT holders (no PnL, ever)
// =====================================================================
const wallets = {};
for (const id in owners) { const a = owners[id]; if (!a) continue; (wallets[a] ||= { tokenIds: [], count: 0 }); wallets[a].tokenIds.push(+id); wallets[a].count++; }
const addrs = Object.keys(wallets);
const ownersRaw = owners; // {id:owner}
const heldBy = {}; for (const id in ownersRaw) { (heldBy[ownersRaw[id]] ||= []).push(+id); }

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
// wallets whose clearinghouse call failed: not flat, just unread. Surfaced so pages
// can say "couldn't read this wallet" instead of publishing a false "sitting flat".
const holdersUnread = Object.values(positions).filter(w => w.error).length;
const index = { generatedAt, holdersTotal, holdersWithPosition, holdersUnread,
  awakeTokens: 0, // filled in once cat_states is derived below
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
  // The table renders the top 12 legs, but the coin filter has to see the WHOLE book
  // or a mid-cap returns "3 holders" when 9 hold it. A few KB buys correct filtering.
  const coinsHeld = [...new Set(pos.map(p => p.coin))];
  rows.push({ owner, id: rep, rarityRank: rrOf[rep], heldCount: held.length, totalNotional, netNotional,
    positions: pos.slice(0, 12), posCount: pos.length, coins: coinsHeld });
}
rows.sort((a,b)=> b.totalNotional - a.totalNotional);
const deskOut = JSON.stringify({ generatedAt, holdersTotal, holdersWithPosition, rows: rows.slice(0, 200) });
// desk.json embeds the same position objects as positions.json, so it gets the same guard
if (FORBIDDEN.some(k => deskOut.includes(k))){ console.error("FATAL: forbidden PnL key in desk.json"); process.exit(1); }
fs.writeFileSync(path.join(OUT, "desk.json"), deskOut);

// ---- history.json : rolling sentiment history for The Pulse (append, cap 8800 points) ----
try {
  const HFILE = path.join(OUT, "history.json");
  let hist = []; try { hist = JSON.parse(fs.readFileSync(HFILE)).points || []; } catch {}
  hist.push({ t: Math.floor(Date.now()/1000),
    nl: walletsNetLong, ns: walletsNetShort, live: holdersWithPosition,
    lp: +(longNotional/Math.max(1,longNotional+shortNotional)).toFixed(4),
    ln: Math.round(longNotional), sn: Math.round(shortNotional) });
  // 8800 points at the real cadence (median ~95 min between runs) is roughly 18 months
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

// ---- cat_states.json : per-cat live stance for the living hero ----
// 0 flat · 1 net long · 2 net short · 3 owner's wallet could not be read this cycle
let states = "";
let awakeTokens = 0, unreadTokens = 0;
for (let id = 1; id <= SUPPLY; id++) {
  const owner = ownersRaw[id]; const w = owner ? positions[owner] : null;
  if (w && w.error) { states += "3"; unreadTokens++; continue; }
  if (!w || !w.hasPosition) { states += "0"; continue; }
  let net = 0; for (const p of w.positions) net += (p.direction === "long" ? 1 : -1) * p.notionalUsd;
  states += net >= 0 ? "1" : "2";
  awakeTokens++;
}
fs.writeFileSync(path.join(OUT, "cat_states.json"), JSON.stringify({ generatedAt, states, awakeTokens, unreadTokens }));

// index.json quotes an awake count that the landing page draws one particle per TOKEN
// for, so it has to be the token count, not the wallet count. Rewritten now that
// cat_states has been derived.
index.awakeTokens = awakeTokens;
index.unreadTokens = unreadTokens;
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index));

console.log(`\nchain ${chainOK ? "OK" : "SKIPPED"} @block ${ownersBlock}`);
console.log(`holders ${holdersTotal}, live ${holdersWithPosition} (${(index.participationRate*100).toFixed(1)}%), unread ${holdersUnread}, errors ${errors}`);
console.log(`tokens awake ${awakeTokens}, unread ${unreadTokens}`);
console.log(`net-long wallets ${walletsNetLong}, net-short ${walletsNetShort}; long by notional ${(index.byNotional.longPct*100).toFixed(1)}%`);
console.log(`desk rows ${Math.min(200,rows.length)} (of ${rows.length} trading holders)`);
