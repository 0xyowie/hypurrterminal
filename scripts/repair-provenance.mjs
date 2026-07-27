// Repair provenance chains that are missing transfers.
//
// Why this exists: the incremental scan in refresh-prod.mjs appends hops from the
// Transfer logs it reads, and then reconciles `currentOwner` against the ownership
// map. If a log window was ever missed, that reconcile quietly rewrites the owner
// while the chain keeps its old tail — so the passport timeline ends on a wallet that
// no longer holds the Hypurr, and the flip count is short.
//
// This finds every token where the chain does not end on the current owner and
// rescans the chain for exactly those token ids, in 100k-block windows against an RPC
// that allows them, then merges the missing hops back in with real block timestamps.
//
// Standalone:  node scripts/repair-provenance.mjs [--dry]
// Programmatic: import { repairProvenance } from "./repair-provenance.mjs"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceForLeg, DUST } from "./sale-price.mjs";

const NFT = "0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const WHYPE = "0x5555555555555555555555555555555555555555";
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DIST = "0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";

// Endpoints that accept a 100k-block eth_getLogs window. The official node caps at
// 1,000, which would turn this into 25,000 requests instead of 250.
const WIDE_RPCS = [
  "https://rpc.purroofgroup.com",
  "https://hyperliquid.lava.build",
  "https://rpc.hyperliquid.xyz/evm",   // last resort: 1k windows
];
const WINDOW = 100_000;
const NARROW_WINDOW = 1_000;
const MAX_TOKENS = Number(process.env.REPAIR_MAX_TOKENS || 60);

const hex = (n) => "0x" + n.toString(16);
const topicId = (id) => "0x" + id.toString(16).padStart(64, "0");
const addrOf = (topic) => ("0x" + topic.slice(26)).toLowerCase();

function makeRpc(log) {
  let idx = 0;
  return async function rpc(method, params, tries = 6) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      const url = WIDE_RPCS[(idx + i) % WIDE_RPCS.length];
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        idx = (idx + i) % WIDE_RPCS.length;      // stick with whoever answered
        return { result: j.result, url };
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
      }
    }
    throw new Error(`${method} failed: ${lastErr?.message}`);
  };
}

async function pmap(items, worker, concurrency = 4, onProgress) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function run() {
    while (i < items.length) {
      const my = i++;
      out[my] = await worker(items[my], my);
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return out;
}

// Block whose timestamp is at or just before `ts`. HyperEVM runs ~1s blocks, so the
// linear estimate lands close and the binary search only trims a few hundred blocks.
async function blockAtTime(rpc, ts, head, headTs) {
  let lo = 1, hi = head;
  let guess = Math.max(1, head - Math.floor((headTs - ts) / 0.98));
  for (let i = 0; i < 40 && lo < hi; i++) {
    const probe = Math.min(hi, Math.max(lo, guess));
    const { result: b } = await rpc("eth_getBlockByNumber", [hex(probe), false]);
    if (!b) { hi = probe - 1; guess = Math.floor((lo + hi) / 2); continue; }
    const bts = parseInt(b.timestamp, 16);
    if (Math.abs(bts - ts) < 120) return Math.max(1, probe - 5_000);
    if (bts < ts) { lo = probe + 1; } else { hi = probe - 1; }
    guess = Math.floor((lo + hi) / 2);
  }
  return Math.max(1, lo - 5_000);
}

export async function repairProvenance({ root, log = console.log, dry = false } = {}) {
  const OUT = path.join(root, "site/data");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f)));

  const provFile = read("provenance.json");
  const prov = provFile.prov;
  const owners = read("owners.json");
  const sales = read("sales.json");

  const broken = [];
  for (const id in prov) {
    const p = prov[id];
    const chain = p.chain || [];
    const owner = owners[id] || p.currentOwner;
    if (!chain.length || chain[chain.length - 1].owner !== owner) broken.push(+id);
  }

  if (!broken.length) { log("provenance: every chain ends on the current owner, nothing to repair"); return { repaired: [], broken: [] }; }
  log(`provenance: ${broken.length} chain(s) do not end on the current owner: ${broken.join(", ")}`);
  if (broken.length > MAX_TOKENS) {
    log(`provenance: ${broken.length} > REPAIR_MAX_TOKENS (${MAX_TOKENS}) — this looks like a pipeline failure, not drift. Skipping.`);
    return { repaired: [], broken };
  }

  const rpc = makeRpc(log);
  const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
  const headTs = parseInt((await rpc("eth_getBlockByNumber", [hex(head), false])).result.timestamp, 16);

  // Scan back to just before the oldest surviving hop among the broken tokens.
  const oldestTs = Math.min(...broken.map((id) => {
    const c = prov[id].chain;
    return c.length ? c[c.length - 1].ts : prov[id].airdropTs;
  }));
  const fromBlock = await blockAtTime(rpc, oldestTs, head, headTs);
  log(`provenance: rescanning blocks ${fromBlock}..${head} (${((head - fromBlock) / 1e6).toFixed(1)}M) for ${broken.length} token ids`);

  const topics = [XFER, null, null, broken.map(topicId)];
  const ranges = [];
  for (let f = fromBlock; f <= head; f += WINDOW) ranges.push([f, Math.min(f + WINDOW - 1, head)]);

  const parts = await pmap(ranges, async ([f, t]) => {
    try {
      const { result } = await rpc("eth_getLogs", [{ address: NFT, topics, fromBlock: hex(f), toBlock: hex(t) }]);
      return result || [];
    } catch (e) {
      // Fall back to 1k windows for this range if every wide endpoint refused it.
      const small = [];
      for (let a = f; a <= t; a += NARROW_WINDOW) {
        const { result } = await rpc("eth_getLogs", [{ address: NFT, topics, fromBlock: hex(a), toBlock: hex(Math.min(a + NARROW_WINDOW - 1, t)) }]);
        small.push(...(result || []));
      }
      return small;
    }
  }, 4, (d, n) => { if (d % 50 === 0) log(`  …${d}/${n} windows`); });

  const logs = parts.flat().map((l) => ({
    id: parseInt(l.topics[3], 16),
    from: addrOf(l.topics[1]),
    to: addrOf(l.topics[2]),
    block: parseInt(l.blockNumber, 16),
    li: parseInt(l.logIndex, 16),
    tx: l.transactionHash,
  })).sort((a, b) => a.block - b.block || a.li - b.li);
  log(`provenance: found ${logs.length} transfer log(s) for those tokens`);

  // Timestamps for the blocks we actually need.
  const blocks = [...new Set(logs.map((l) => l.block))];
  const tsMap = {};
  await pmap(blocks, async (n) => {
    const { result: b } = await rpc("eth_getBlockByNumber", [hex(n), false]);
    if (b?.timestamp) tsMap[n] = parseInt(b.timestamp, 16);
  }, 6);
  const unreadable = blocks.filter((b) => tsMap[b] === undefined);
  if (unreadable.length) {
    log(`provenance: ${unreadable.length} block timestamp(s) unreadable — aborting rather than stamping a hop with a guess`);
    return { repaired: [], broken };
  }

  const repaired = [], stillBroken = [];
  for (const id of broken) {
    const p = prov[id];
    const chain = p.chain || [];
    const lastTs = chain.length ? chain[chain.length - 1].ts : 0;
    const seen = new Set(chain.map((h) => `${h.ts}|${h.owner}`));

    const missing = logs
      .filter((l) => l.id === id && tsMap[l.block] >= lastTs)
      .map((l) => ({
        owner: l.to,
        ts: tsMap[l.block],
        kind: l.from === ZERO ? "mint" : l.from === DIST ? "airdrop" : "trade",
        tx: l.tx,
      }))
      .filter((h) => !seen.has(`${h.ts}|${h.owner}`));

    if (!missing.length) { stillBroken.push(id); continue; }
    for (const h of missing) chain.push({ owner: h.owner, ts: h.ts, kind: h.kind });
    chain.sort((a, b) => a.ts - b.ts);
    p.chain = chain;
    p.currentOwner = chain[chain.length - 1].owner;
    // Recount rather than increment: the chain is now the authority for this token.
    p.trades = chain.filter((h) => h.kind === "trade").length;

    const ok = p.currentOwner === owners[id];
    (ok ? repaired : stillBroken).push(id);
    log(`  #${id}: +${missing.length} hop(s) → ends on ${p.currentOwner}${ok ? "" : ` (still != owners.json ${owners[id]})`}, ${p.trades} trades`);
    if (missing.some((h) => h.kind === "trade")) {
      log(`    unpriced sale tx(s): ${missing.filter((h) => h.kind === "trade").map((h) => h.tx).join(", ")}`);
    }
  }

  // ---- price the trade hops we just recovered ----
  // A missing hop usually means a missing sale, so sales.json, the volume stats and
  // the rarity/price scatter are all short until these are added back.
  const newTrades = [];
  for (const id of repaired) {
    for (const l of logs) {
      if (l.id !== id) continue;
      const ts = tsMap[l.block];
      if (l.from === ZERO || l.from === DIST) continue;
      const known = (sales.byToken[id] || []).some((s) => Math.abs(s.ts - ts) < 2);
      if (!known) newTrades.push({ ...l, ts });
    }
  }
  const pricedSales = [];
  if (newTrades.length) {
    const byTx = {};
    for (const t of newTrades) (byTx[t.tx] ||= []).push(t);
    for (const [h, items] of Object.entries(byTx)) {
      try {
        const { result: tx } = await rpc("eth_getTransactionByHash", [h]);
        const { result: rc } = await rpc("eth_getTransactionReceipt", [h]);
        if (!tx || !rc) { log(`  sale ${h}: tx or receipt unreadable, skipping`); continue; }
        // Every NFT leg in the tx, not just our tokens — a sweep of five listings
        // priced as if it were one would put the price 5x too high.
        const allLegs = rc.logs
          .filter((e) => e.address.toLowerCase() === NFT && e.topics[0] === XFER && e.topics.length === 4)
          .map((e) => ({ id: parseInt(e.topics[3], 16), from: addrOf(e.topics[1]), to: addrOf(e.topics[2]) }));
        const whypeLegs = rc.logs
          .filter((e) => e.address.toLowerCase() === WHYPE && e.topics[0] === XFER && e.topics.length === 3)
          .map((e) => ({ from: addrOf(e.topics[1]), amt: Number(BigInt(e.data)) / 1e18 }));
        const txInfo = { to: (tx.to || "").toLowerCase(), val: tx.value || "0x0" };
        for (const it of items) {
          const leg = allLegs.find((l) => l.id === it.id && l.to === it.to) || it;
          const per = priceForLeg(leg, allLegs, txInfo, whypeLegs, NFT);
          if (per == null || per < DUST) { log(`  sale ${h} #${it.id}: not a market sale (${per})`); continue; }
          pricedSales.push({ id: it.id, ts: it.ts, price: Math.round(per * 100) / 100 });
        }
      } catch (e) {
        log(`  sale ${h}: ${e.message}`);
      }
    }
    for (const s of pricedSales) {
      (sales.byToken[s.id] ||= []).push({ ts: s.ts, price: s.price });
      sales.byToken[s.id].sort((a, b) => a.ts - b.ts);
      log(`  #${s.id}: recovered sale ${s.price} HYPE`);
    }
  }

  if (dry) { log("provenance: --dry, not writing"); return { repaired, broken: stillBroken, sales: pricedSales }; }

  if (repaired.length) {
    fs.writeFileSync(path.join(OUT, "provenance.json"), JSON.stringify({ ...provFile, prov }));
    // flips.json mirrors prov.trades and feeds The Pride, so it moves in lockstep.
    const flipsPath = path.join(OUT, "flips.json");
    if (fs.existsSync(flipsPath)) {
      const flips = JSON.parse(fs.readFileSync(flipsPath));
      for (const id of repaired) flips.flips[id] = prov[id].trades;
      flips.updated = new Date().toISOString();
      fs.writeFileSync(flipsPath, JSON.stringify(flips));
    }
    log(`provenance: repaired ${repaired.length} chain(s), wrote provenance.json + flips.json`);
  }

  if (pricedSales.length) {
    // Recompute the headline stats from the full book rather than nudging them.
    const flat = [];
    for (const id in sales.byToken) for (const s of sales.byToken[id]) flat.push({ id: +id, hype: s.price, ts: s.ts });
    flat.sort((a, b) => a.hype - b.hype);
    const recent = flat.slice().sort((a, b) => b.ts - a.ts);
    const totalHype = flat.reduce((s, x) => s + x.hype, 0);
    sales.stats = {
      ...sales.stats,
      totalSales: flat.length,
      totalVolumeHype: Math.round(totalHype),
      avgPriceHype: Math.round(totalHype / Math.max(1, flat.length)),
      minPriceHype: Math.round(flat[0].hype),
      maxPriceHype: Math.round(flat[flat.length - 1].hype),
      maxSale: { id: flat[flat.length - 1].id, hype: Math.round(flat[flat.length - 1].hype) },
      lastSaleTs: recent[0].ts,
      tokensWithSale: Object.keys(sales.byToken).length,
    };
    fs.writeFileSync(path.join(OUT, "sales.json"), JSON.stringify(sales));
    log(`provenance: recovered ${pricedSales.length} sale(s), rewrote sales.json (${flat.length} sales total)`);
  }

  if (stillBroken.length) log(`provenance: ${stillBroken.length} chain(s) could not be repaired: ${stillBroken.join(", ")}`);
  return { repaired, broken: stillBroken, sales: pricedSales };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const r = await repairProvenance({ root, dry: process.argv.includes("--dry") });
  process.exit(r.broken.length ? 1 : 0);
}
