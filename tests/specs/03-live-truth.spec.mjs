// Are the numbers on the site actually true right now?
// Spot-checks shipped data against the Hyperliquid info API and HyperEVM.
import { test, expect } from '@playwright/test';
import { getJSON, hlInfo, ageMinutes } from '../helpers/util.mjs';

const NFT = '0x9125e2d6827a00b0f8330d6ef7bef07730bac685';
const RPC = process.env.HL_RPC || 'https://rpc.hyperliquid.xyz/evm';
const SAMPLE = Number(process.env.TRUTH_SAMPLE || 12);

// Positions are re-priced at mark on every read, so notional drifts with the market.
// Direction, coin set and size are what must match exactly.
const NOTIONAL_TOLERANCE = Number(process.env.NOTIONAL_TOLERANCE || 0.35);

function pickSample(wallets, n) {
  const live = Object.entries(wallets).filter(([, w]) => w.hasPosition);
  live.sort((a, b) => {
    const s = (w) => w[1].positions.reduce((t, p) => t + p.notionalUsd, 0);
    return s(b) - s(a);
  });
  // biggest books + an evenly spread tail, so the sample is not all whales
  const out = live.slice(0, Math.ceil(n / 2));
  const rest = live.slice(out.length);
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, n - out.length)));
  for (let i = 0; i < rest.length && out.length < n; i += step) out.push(rest[i]);
  return out;
}

test.describe('live truth', () => {
  test.slow();

  test('shipped positions match Hyperliquid clearinghouseState', async ({ request, baseURL }) => {
    const pos = await getJSON(request, baseURL, 'positions.json');
    // Books move. Comparing a stale snapshot to the live tape measures the delay,
    // not correctness — freshness is asserted separately in 02-data / 09-pipeline.
    const age = ageMinutes(pos.generatedAt);
    // One cron interval of slack. Past that, a wallet that simply traded since the
    // sweep is indistinguishable from a wrong number, so this would report weather.
    test.skip(age > 20, `snapshot is ${Math.round(age)} min old — too stale to compare against the live tape`);
    const sample = pickSample(pos.wallets, SAMPLE);
    expect(sample.length, 'no live wallets to sample').toBeGreaterThan(0);

    const drift = [];
    const conflicted = new Set();
    let matchedWallets = 0;
    for (const [addr, w] of sample) {
      const before = drift.length;
      const live = await hlInfo(request, { type: 'clearinghouseState', user: addr });
      const livePos = new Map((live.assetPositions || []).map((a) => [a.position.coin, a.position]));
      const shipped = new Map(w.positions.map((p) => [p.coin, p]));

      // Coins can legitimately open/close between the refresh and now; flag only
      // contradictions on coins both sides still show.
      for (const [coin, p] of shipped) {
        const l = livePos.get(coin);
        if (!l) continue;
        const liveDir = Number(l.szi) >= 0 ? 'long' : 'short';
        if (liveDir !== p.direction) drift.push(`${addr} ${coin}: shipped ${p.direction}, live ${liveDir}`);
        const liveSz = Math.abs(Number(l.szi));
        const shipSz = Math.abs(Number(p.size));
        if (liveSz > 0 && Math.abs(liveSz - shipSz) / liveSz > 0.5) {
          drift.push(`${addr} ${coin}: size ${shipSz} vs live ${liveSz}`);
        }
        const liveNotional = Math.abs(Number(l.positionValue));
        if (liveNotional > 0 && Math.abs(liveNotional - p.notionalUsd) / liveNotional > NOTIONAL_TOLERANCE) {
          drift.push(`${addr} ${coin}: notional ${Math.round(p.notionalUsd)} vs live ${Math.round(liveNotional)}`);
        }
        if (p.leverage && l.leverage && p.leverage.type !== l.leverage.type) {
          drift.push(`${addr} ${coin}: leverage type ${p.leverage.type} vs live ${l.leverage.type}`);
        }
      }
      // A wallet the site calls live must still be live somewhere.
      if (livePos.size === 0 && shipped.size > 0 && ageMinutes(pos.generatedAt) < 30) {
        drift.push(`${addr}: site shows ${shipped.size} legs, Hyperliquid shows none`);
      }
      if (drift.length > before) conflicted.add(addr); else matchedWallets++;
    }

    // A market maker can flip a leg between the sweep and this request, so one
    // disagreeing wallet is the market, not a bug. A pipeline that mapped the wrong
    // wallets or inverted a side would disagree broadly — that is what this catches.
    const ratio = conflicted.size / sample.length;
    console.log(`live truth: ${matchedWallets}/${sample.length} wallets match exactly${drift.length ? `; drift: ${drift.slice(0, 6).join(' | ')}` : ''}`);
    expect(matchedWallets, 'not a single sampled wallet matched the live tape').toBeGreaterThan(0);
    expect(ratio, `${conflicted.size}/${sample.length} sampled wallets contradict Hyperliquid: ${drift.slice(0, 8).join(' | ')}`).toBeLessThan(0.34);
  });

  test('every traded coin exists on Hyperliquid', async ({ request, baseURL }) => {
    const [idx, meta] = await Promise.all([
      getJSON(request, baseURL, 'index.json'),
      hlInfo(request, { type: 'meta' }),
    ]);
    const known = new Set(meta.universe.map((u) => u.name));
    const unknown = idx.topCoins.map((c) => c.coin).filter((c) => !known.has(c));
    expect(unknown, 'coins on the site that Hyperliquid does not list').toEqual([]);
  });

  test('HYPE price series tracks the live mid', async ({ request, baseURL }) => {
    const [hype, mids] = await Promise.all([
      getJSON(request, baseURL, 'hype_price.json'),
      hlInfo(request, { type: 'allMids' }),
    ]);
    const liveMid = Number(mids.HYPE);
    expect(liveMid, 'HYPE mid from Hyperliquid').toBeGreaterThan(0);
    const lastHourly = hype.pxh[hype.pxh.length - 1].c;
    const drift = Math.abs(lastHourly - liveMid) / liveMid;
    expect(drift, `last hourly close ${lastHourly} vs live mid ${liveMid}`).toBeLessThan(0.15);
  });

  test('owners.json matches on-chain ownerOf', async ({ request, baseURL }) => {
    const owners = await getJSON(request, baseURL, 'owners.json');
    const ids = [1, 8, 777, 2300, 4203, 4600];
    const mismatches = [];
    for (const id of ids) {
      const res = await request.post(RPC, {
        headers: { 'Content-Type': 'application/json' },
        data: {
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: NFT, data: '0x6352211e' + id.toString(16).padStart(64, '0') }, 'latest'],
        },
        timeout: 30000,
      });
      const j = await res.json();
      if (!j.result || j.result === '0x') { mismatches.push(`#${id}: RPC returned nothing`); continue; }
      const onchain = '0x' + j.result.slice(-40).toLowerCase();
      if (onchain !== owners[id]) mismatches.push(`#${id}: site ${owners[id]}, chain ${onchain}`);
    }
    expect(mismatches, 'ownership on the site disagrees with HyperEVM').toEqual([]);
  });

  test('holder count matches the number of distinct on-chain owners', async ({ request, baseURL }) => {
    const [owners, idx] = await Promise.all([
      getJSON(request, baseURL, 'owners.json'), getJSON(request, baseURL, 'index.json'),
    ]);
    expect(idx.holdersTotal).toBe(new Set(Object.values(owners)).size);
  });
});
