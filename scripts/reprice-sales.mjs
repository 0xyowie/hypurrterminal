// One-off backfill: rebuild the ENTIRE sale history with per-buyer payment attribution.
//
// The original reconstruction priced a marketplace transaction by taking the single
// largest WHYPE transfer in the receipt and dividing it evenly across every NFT in
// that transaction. That is correct when one buyer sweeps several listings, and wrong
// when a Seaport bulk-fulfil batches several INDEPENDENT buyers: tx 0x400ba80b… held
// three buyers paying 164.01 / 164.00 / 159.34 WHYPE and all three tokens were written
// at 54.67. It also under-reported single-item sales, because the largest leg is the
// seller's proceeds, not the buyer's outlay.
//
// This script re-derives every price from the buyer side using the shared rules in
// sale-price.mjs, so the backfill and the cron can never disagree.
//
//   node scripts/reprice-sales.mjs             write site/data/sales.json + scatter.json
//   node scripts/reprice-sales.mjs --dry-run   report only, write nothing
//
// Reuses the historical caches in data/ and scans the chain only for the window they
// do not cover, so a re-run is cheap.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceForLeg, isAttributed, DUST } from "./sale-price.mjs";
import { makePool, pmap } from "./rpc-pool.mjs";

const NFT   = "0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const WHYPE = "0x5555555555555555555555555555555555555555";
const XFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO  = "0x0000000000000000000000000000000000000000";
const DIST  = "0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";

// fileURLToPath, not url.pathname: a pathname keeps its percent-encoding, so a
// checkout under a folder with a space in it resolves to "Perps%20trading" and every
// read fails with ENOENT. The CI runner has no spaces in its path and never saw this.
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const D   = path.join(ROOT, "data");
const OUT = path.join(ROOT, "site/data");
const DRY = process.argv.includes("--dry-run");
const rd = f => JSON.parse(fs.readFileSync(f));
const hex = n => "0x" + n.toString(16);


const traits = rd(path.join(D, "traits.json")).tokens;
const rrOf = {}; traits.forEach(t => { rrOf[t.id] = t.rarityRank; });

const pool = makePool();
const rpc = (method, params) => pool.soft(method, params, { tries: 8 });
async function getLogsRange(from, to) {
  const l = await pool.call("eth_getLogs",
    [{ address: NFT, topics: [XFER], fromBlock: hex(from), toBlock: hex(to) }], { tries: 12 });
  if (!Array.isArray(l)) throw new Error(`eth_getLogs ${from}-${to} returned no array`);
  return l;
}

// ---- 1. assemble the full transfer set: cached history + the uncovered window ----
const raw = rd(path.join(D, "transfers_raw.json"));
const transfers = raw.transfers.slice();
const cachedTo = raw.latest;                       // the block the cache was scanned to
const target = (rd(path.join(OUT, "provenance.json")) || {}).lastBlock;
if (!Number.isFinite(target)) throw new Error("site/data/provenance.json has no lastBlock; run the refresh first");
console.log(`cached transfers: ${transfers.length} through block ${cachedTo}`);
console.log(`scanning ${cachedTo + 1} -> ${target} (${target - cachedTo} blocks)`);

// The extension scan is checkpointed to disk after every batch, so an RPC outage
// costs one batch rather than the whole run. Re-running picks up where it stopped.
const EXTF = path.join(D, "transfers_ext.json");
const ext = (() => { try { const e = rd(EXTF); return (e.from === cachedTo + 1) ? e : null; } catch { return null; } })()
  || { from: cachedTo + 1, to: cachedTo, transfers: [] };
if (target > ext.to) {
  const start = ext.to + 1;
  const ranges = [];
  for (let f = start; f <= target; f += 1000) ranges.push([f, Math.min(f + 999, target)]);
  if (ext.transfers.length) console.log(`resuming: ${ext.transfers.length} transfers already scanned to ${ext.to}`);
  const BATCH = 40;
  for (let b = 0; b < ranges.length; b += BATCH) {
    const slice = ranges.slice(b, b + BATCH);
    const parts = await pmap(slice, ([f, t]) => getLogsRange(f, t), 6);
    for (const l of parts.flat()) ext.transfers.push({
      id: parseInt(l.topics[3], 16),
      from: ("0x" + l.topics[1].slice(26)).toLowerCase(),
      to:   ("0x" + l.topics[2].slice(26)).toLowerCase(),
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash,
      li: parseInt(l.logIndex, 16),
    });
    ext.to = slice[slice.length - 1][1];
    fs.writeFileSync(EXTF, JSON.stringify(ext));
    process.stdout.write(`getLogs ${Math.min(b + BATCH, ranges.length)}/${ranges.length} · ${ext.transfers.length} transfers\r`);
  }
  process.stdout.write("\n");
}
for (const t of ext.transfers) if (t.block <= target) transfers.push(t);
transfers.sort((a, b) => a.block - b.block || a.li - b.li);
console.log(`total transfers: ${transfers.length}`);

// ---- 2. trade transactions ----
const trades = transfers.filter(t => t.from !== ZERO && t.from !== DIST);
const byTx = {}; for (const t of trades) (byTx[t.tx] ||= []).push(t);
const txHashes = Object.keys(byTx);
console.log(`trade transfers: ${trades.length} in ${txHashes.length} transactions`);

// ---- 3. transaction envelopes (cached where possible) ----
const txCache = (() => { try { return rd(path.join(D, "tx_cache.json")); } catch { return {}; } })();
const txInfo = {};
for (const h of txHashes) if (txCache[h]) txInfo[h] = txCache[h];
const needTx = txHashes.filter(h => !txInfo[h]);
console.log(`tx envelopes: ${txHashes.length - needTx.length} cached, ${needTx.length} to fetch`);
if (needTx.length) {
  await pmap(needTx, async (h) => { const tx = await rpc("eth_getTransactionByHash", [h]);
    if (tx) txInfo[h] = { to: (tx.to || "").toLowerCase(), val: tx.value || "0x0" }; }, 8, "tx");
  // Persist, so a re-run does not pay for these a second time.
  fs.writeFileSync(path.join(D, "tx_cache.json"), JSON.stringify({ ...txCache, ...txInfo }));
}

// ---- 4. receipts, re-fetched WITH the payer on every WHYPE leg ----
// The old rc_cache.json stored bare amounts, which is exactly the information loss
// that caused the bug, so it cannot be reused. rc_payers.json is the new cache.
const RCF = path.join(D, "rc_payers.json");
const rcInfo = (() => { try { return rd(RCF); } catch { return {}; } })();
const needRc = txHashes.filter(h => {
  const tx = txInfo[h]; if (!tx) return false;
  if (Number(BigInt(tx.val)) / 1e18 > 0.001) return false;   // native payment, no receipt needed
  if (tx.to === NFT) return false;                            // plain transfer, not a sale
  return !rcInfo[h];
});
console.log(`receipts: ${Object.keys(rcInfo).length} cached, ${needRc.length} to fetch`);
if (needRc.length) {
  // Caches are written even on a dry run. They are inputs, not outputs, and paying for
  // several thousand receipts twice to produce the same report helps nobody.
  let sinceSave = 0;
  await pmap(needRc, async (h) => {
    const rc = await rpc("eth_getTransactionReceipt", [h]);
    if (!rc || !rc.logs) return;
    const w = [];
    for (const e of rc.logs) {
      if (e.topics[0] === XFER && e.topics.length === 3 && e.address.toLowerCase() === WHYPE) {
        w.push({ from: ("0x" + e.topics[1].slice(26)).toLowerCase(), amt: Number(BigInt(e.data)) / 1e18 });
      }
    }
    rcInfo[h] = { w };
    if (++sinceSave >= 400) { sinceSave = 0; fs.writeFileSync(RCF, JSON.stringify(rcInfo)); }
  }, 8, "receipts");
  fs.writeFileSync(RCF, JSON.stringify(rcInfo));
}

// ---- 4b. no silent gaps ----
// A missing envelope or receipt is not a neutral gap. The leg falls through to
// "unpriceable" and a real sale disappears from the history without anything in the
// output saying so. That is exactly how the first dry run came back 855 sales short:
// pruned nodes answer eth_getTransactionReceipt with a successful `null`, the pool
// took the null as an answer, and the sale looked unpaid. Chase the stragglers, then
// refuse to write anything if any are still missing.
const rcNeeded = h => {
  const tx = txInfo[h]; if (!tx) return false;
  if (Number(BigInt(tx.val)) / 1e18 > 0.001) return false;
  if (tx.to === NFT) return false;
  return true;
};
for (let pass = 1; pass <= 3; pass++) {
  const mtx = txHashes.filter(h => !txInfo[h]);
  const mrc = txHashes.filter(h => rcNeeded(h) && !rcInfo[h]);
  if (!mtx.length && !mrc.length) break;
  console.log(`gap pass ${pass}: ${mtx.length} envelopes, ${mrc.length} receipts still missing`);
  await pmap(mtx, async (h) => { const tx = await rpc("eth_getTransactionByHash", [h]);
    if (tx) txInfo[h] = { to: (tx.to || "").toLowerCase(), val: tx.value || "0x0" }; }, 4, "retry tx");
  await pmap(mrc, async (h) => {
    const rc = await rpc("eth_getTransactionReceipt", [h]);
    if (!rc || !rc.logs) return;
    const w = [];
    for (const e of rc.logs) if (e.topics[0] === XFER && e.topics.length === 3 && e.address.toLowerCase() === WHYPE)
      w.push({ from: ("0x" + e.topics[1].slice(26)).toLowerCase(), amt: Number(BigInt(e.data)) / 1e18 });
    rcInfo[h] = { w };
  }, 4, "retry receipts");
  fs.writeFileSync(path.join(D, "tx_cache.json"), JSON.stringify({ ...txCache, ...txInfo }));
  fs.writeFileSync(RCF, JSON.stringify(rcInfo));
}
const stillTx = txHashes.filter(h => !txInfo[h]);
const stillRc = txHashes.filter(h => rcNeeded(h) && !rcInfo[h]);
if (stillTx.length || stillRc.length) {
  console.error(`\nincomplete chain data: ${stillTx.length} envelopes and ${stillRc.length} receipts could not be fetched.`);
  console.error(`Writing now would drop those sales silently. Re-run when the RPCs are healthier.`);
  console.error(`pool health: ${pool.health()}`);
  process.exit(1);
}

// ---- 5. block timestamps ----
// blockts.json holds the real timestamps gathered during the original reconstruction.
// Anything missing is fetched for real rather than interpolated, so no sale carries a
// guessed date.
const blockts = (() => { try { return rd(path.join(D, "blockts.json")); } catch { return {}; } })();
const tradeBlocks = [...new Set(trades.map(t => t.block))];
const missingTs = tradeBlocks.filter(b => blockts[b] == null);
console.log(`block timestamps: ${tradeBlocks.length - missingTs.length} cached, ${missingTs.length} to fetch`);
await pmap(missingTs, async (n) => { const b = await rpc("eth_getBlockByNumber", [hex(n), false]);
  if (b && b.timestamp) blockts[n] = parseInt(b.timestamp, 16); }, 8, "blocks");
if (missingTs.length) fs.writeFileSync(path.join(D, "blockts.json"), JSON.stringify(blockts));
const stillTs = tradeBlocks.filter(b => blockts[b] == null);
if (stillTs.length) {
  console.error(`\n${stillTs.length} block timestamps could not be fetched; every sale in those blocks would be dropped.`);
  console.error(`pool health: ${pool.health()}`);
  process.exit(1);
}

// ---- 6. reprice ----
const byToken = {};
let priced = 0, skippedDust = 0, skippedUnpriceable = 0, skippedNoTs = 0, fallbackLegs = 0, bulkTxs = 0;
for (const h of txHashes) {
  const items = byTx[h];
  if (items.length > 1) bulkTxs++;
  for (const it of items) {
    const ts = blockts[it.block];
    if (ts == null) { skippedNoTs++; continue; }
    const per = priceForLeg(it, items, txInfo[h], (rcInfo[h] || {}).w, NFT);
    if (per == null) { skippedUnpriceable++; continue; }
    if (per < DUST) { skippedDust++; continue; }
    if (!isAttributed(it, txInfo[h], (rcInfo[h] || {}).w)) fallbackLegs++;
    (byToken[it.id] ||= []).push({ ts, price: Math.round(per * 100) / 100 });
    priced++;
  }
}
for (const id in byToken) byToken[id].sort((a, b) => a.ts - b.ts);

// ---- 7. stats, identical shape to the cron's ----
const flat = []; for (const id in byToken) for (const s of byToken[id]) flat.push({ id: +id, hype: s.price, ts: s.ts });
flat.sort((a, b) => a.hype - b.hype);
const recent = flat.slice().sort((a, b) => b.ts - a.ts);
const totalHype = flat.reduce((s, x) => s + x.hype, 0);
const generatedAt = new Date().toISOString();
const stats = { totalSales: flat.length, totalVolumeHype: Math.round(totalHype),
  avgPriceHype: Math.round(totalHype / Math.max(1, flat.length)),
  minPriceHype: flat.length ? Math.round(flat[0].hype) : null,
  maxPriceHype: flat.length ? Math.round(flat[flat.length - 1].hype) : null,
  maxSale: flat.length ? { id: flat[flat.length - 1].id, hype: Math.round(flat[flat.length - 1].hype) } : null,
  lastSaleTs: recent[0]?.ts || null, tokensWithSale: Object.keys(byToken).length,
  currencyNote: "HYPE + WHYPE, reconstructed from on-chain payments across all marketplaces" };

// ---- 8. compare against what is live before overwriting anything ----
const prev = (() => { try { return rd(path.join(OUT, "sales.json")); } catch { return null; } })();
if (prev) {
  const pb = prev.byToken || {};
  let same = 0, changed = 0, added = 0, removed = 0; const worst = [];
  const ids = new Set([...Object.keys(pb), ...Object.keys(byToken)]);
  for (const id of ids) {
    const a = pb[id] || [], b = byToken[id] || [];
    const key = s => s.ts + "";
    const am = new Map(a.map(s => [key(s), s.price])), bm = new Map(b.map(s => [key(s), s.price]));
    for (const [k, v] of bm) {
      if (!am.has(k)) { added++; continue; }
      const old = am.get(k);
      if (Math.abs(old - v) < 0.011) same++;
      else { changed++; worst.push({ id: +id, old, now: v, x: +(v / Math.max(0.01, old)).toFixed(2) }); }
    }
    for (const k of am.keys()) if (!bm.has(k)) removed++;
  }
  worst.sort((a, b) => Math.abs(b.now - b.old) - Math.abs(a.now - a.old));
  console.log(`\n--- diff against live sales.json ---`);
  console.log(`unchanged ${same} · repriced ${changed} · new ${added} · dropped ${removed}`);
  console.log(`largest corrections:`);
  for (const w of worst.slice(0, 15)) console.log(`  #${w.id}  ${w.old} -> ${w.now} HYPE  (${w.x}x)`);
  console.log(`volume ${prev.stats?.totalVolumeHype?.toLocaleString()} -> ${stats.totalVolumeHype.toLocaleString()} HYPE`);
}

console.log(`\npriced ${priced} legs across ${txHashes.length} txs (${bulkTxs} multi-item)`);
console.log(`fallback-priced legs (payer not attributable): ${fallbackLegs}`);
console.log(`skipped: ${skippedUnpriceable} unpriceable, ${skippedDust} below the ${DUST} HYPE dust floor, ${skippedNoTs} without a timestamp`);

if (DRY) { console.log("\n--dry-run: nothing written"); process.exit(0); }

fs.writeFileSync(path.join(OUT, "sales.json"), JSON.stringify({ generatedAt, stats, byToken }));

// rebuild the scatter from the corrected prices so The Index agrees with the passports
const pts = [];
for (const id in byToken) { const h = byToken[id]; if (!h.length) continue;
  const last = h[h.length - 1].price; if (!(last > 0)) continue;
  pts.push({ id: +id, rr: rrOf[id], p: last }); }
pts.sort((a, b) => a.id - b.id);
fs.writeFileSync(path.join(OUT, "scatter.json"), JSON.stringify({ updated: generatedAt, pts }));

console.log(`\nwrote site/data/sales.json (${stats.totalSales} sales, ${stats.tokensWithSale} tokens)`);
console.log(`wrote site/data/scatter.json (${pts.length} points)`);
