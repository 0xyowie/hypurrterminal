// The shipped JSON must be well-formed, internally consistent and fresh —
// and must never contain a PnL field.
import { test, expect } from '@playwright/test';
import { SUPPLY, DATA_FILES, FORBIDDEN_PNL, IS_LIVE, getJSON, ageMinutes, isAddress, near } from '../helpers/util.mjs';

const MAX_AGE_MIN = Number(process.env.MAX_DATA_AGE_MIN || 180);

test.describe('data files', () => {
  test('every data file is served and parses', async ({ request, baseURL }) => {
    const bad = [];
    for (const f of DATA_FILES) {
      try { await getJSON(request, baseURL, f); } catch (e) { bad.push(`${f}: ${e.message}`); }
    }
    expect(bad).toEqual([]);
  });

  test('no PnL, balance or liquidation field anywhere in the data', async ({ request, baseURL }) => {
    const hits = [];
    for (const f of DATA_FILES) {
      const res = await request.get(`${baseURL}/data/${f}`);
      const text = await res.text();
      for (const k of FORBIDDEN_PNL) if (text.includes(k)) hits.push(`${f} contains ${k}`);
    }
    expect(hits, 'the no-PnL rule is broken').toEqual([]);
  });

  test('tokens, owners, rarity and provenance cover all 4,600', async ({ request, baseURL }) => {
    const [tokens, owners, rarity, prov, flips] = await Promise.all([
      getJSON(request, baseURL, 'tokens.json'), getJSON(request, baseURL, 'owners.json'),
      getJSON(request, baseURL, 'rarity.json'), getJSON(request, baseURL, 'provenance.json'),
      getJSON(request, baseURL, 'flips.json'),
    ]);

    expect(tokens.supply).toBe(SUPPLY);
    expect(tokens.tokens).toHaveLength(SUPPLY);
    const ids = tokens.tokens.map((t) => t.id).sort((a, b) => a - b);
    expect(ids[0]).toBe(1);
    expect(ids[SUPPLY - 1]).toBe(SUPPLY);
    expect(new Set(ids).size).toBe(SUPPLY);
    expect(tokens.tokens.every((t) => t.rr >= 1 && t.rr <= SUPPLY)).toBeTruthy();
    expect(new Set(tokens.tokens.map((t) => t.rr)).size, 'rarity ranks must be unique').toBe(SUPPLY);
    expect(tokens.tokens.every((t) => t.t && Object.keys(t.t).length > 0)).toBeTruthy();

    expect(Object.keys(owners)).toHaveLength(SUPPLY);
    const badOwners = Object.entries(owners).filter(([, a]) => !isAddress(a)).slice(0, 5);
    expect(badOwners, 'malformed owner addresses').toEqual([]);

    expect(Object.keys(prov.prov)).toHaveLength(SUPPLY);
    const provMismatch = Object.entries(prov.prov)
      .filter(([id, p]) => p.currentOwner !== owners[id]).slice(0, 5);
    expect(provMismatch, 'provenance currentOwner disagrees with owners.json').toEqual([]);

    // Every chain starts at the mint and is chronological.
    const badChain = Object.entries(prov.prov).filter(([, p]) => {
      const c = p.chain || [];
      if (!c.length || c[0].kind !== 'mint') return true;
      for (let i = 1; i < c.length; i++) if (c[i].ts < c[i - 1].ts) return true;
      return c[c.length - 1].owner !== p.currentOwner;
    }).slice(0, 5);
    expect(badChain, 'broken provenance chains').toEqual([]);

    expect(Object.keys(flips.flips)).toHaveLength(SUPPLY);
    const flipMismatch = Object.entries(flips.flips)
      .filter(([id, n]) => n !== (prov.prov[id].trades || 0)).slice(0, 5);
    expect(flipMismatch, 'flips.json disagrees with provenance trades').toEqual([]);

    // Trait frequency tables must account for every token in every category.
    for (const cat of rarity.categories) {
      const total = Object.values(rarity.freq[cat]).reduce((a, b) => a + b, 0);
      expect(total, `${cat} frequency total`).toBe(SUPPLY);
    }
  });

  test('positions.json is well-formed and covers the holder set', async ({ request, baseURL }) => {
    const [pos, owners] = await Promise.all([
      getJSON(request, baseURL, 'positions.json'), getJSON(request, baseURL, 'owners.json'),
    ]);
    const holders = new Set(Object.values(owners));

    expect(pos.source).toBe('clearinghouseState');
    if (IS_LIVE) expect(ageMinutes(pos.generatedAt), 'positions.json age (minutes)').toBeLessThan(MAX_AGE_MIN);

    const walletAddrs = Object.keys(pos.wallets);
    expect(walletAddrs.length).toBe(holders.size);
    const strangers = walletAddrs.filter((a) => !holders.has(a)).slice(0, 5);
    expect(strangers, 'positions for wallets that hold no Hypurr').toEqual([]);

    const problems = [];
    let withPos = 0, unread = 0;
    for (const [addr, w] of Object.entries(pos.wallets)) {
      if (w.error) { unread++; continue; }
      if (typeof w.hasPosition !== 'boolean' || !Array.isArray(w.positions)) { problems.push(`${addr}: shape`); continue; }
      if (w.hasPosition !== w.positions.length > 0) problems.push(`${addr}: hasPosition disagrees with positions[]`);
      if (w.hasPosition) withPos++;
      for (const p of w.positions) {
        if (!p.coin || typeof p.coin !== 'string') problems.push(`${addr}: bad coin`);
        if (p.direction !== 'long' && p.direction !== 'short') problems.push(`${addr}/${p.coin}: bad direction`);
        if (!(p.notionalUsd > 0)) problems.push(`${addr}/${p.coin}: notional ${p.notionalUsd}`);
        if (!(Math.abs(p.size) > 0)) problems.push(`${addr}/${p.coin}: size ${p.size}`);
        if (p.leverage && !(p.leverage.value > 0)) problems.push(`${addr}/${p.coin}: leverage ${JSON.stringify(p.leverage)}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    // A cycle that read almost nothing is a silent outage, not a quiet market.
    expect(unread / walletAddrs.length, 'share of wallets that could not be read').toBeLessThan(0.05);
    expect(withPos, 'wallets with an open position').toBeGreaterThan(0);
  });

  test('index.json aggregates recompute exactly from positions.json', async ({ request, baseURL }) => {
    const [idx, pos] = await Promise.all([
      getJSON(request, baseURL, 'index.json'), getJSON(request, baseURL, 'positions.json'),
    ]);
    expect(idx.generatedAt).toBe(pos.generatedAt);

    let holdersWithPosition = 0, longN = 0, shortN = 0, longCount = 0, shortCount = 0;
    let netLong = 0, netShort = 0, netFlat = 0;
    const coins = new Map();
    for (const [addr, w] of Object.entries(pos.wallets)) {
      if (!w.hasPosition) continue;
      holdersWithPosition++;
      let net = 0;
      for (const p of w.positions) {
        const c = coins.get(p.coin) || { ln: 0, sn: 0, lw: new Set(), sw: new Set() };
        if (p.direction === 'long') { longN += p.notionalUsd; longCount++; net += p.notionalUsd; c.ln += p.notionalUsd; c.lw.add(addr); }
        else { shortN += p.notionalUsd; shortCount++; net -= p.notionalUsd; c.sn += p.notionalUsd; c.sw.add(addr); }
        coins.set(p.coin, c);
      }
      if (net > 0) netLong++; else if (net < 0) netShort++; else netFlat++;
    }

    expect(idx.holdersTotal).toBe(Object.keys(pos.wallets).length);
    expect(idx.holdersWithPosition).toBe(holdersWithPosition);
    expect(idx.byWallet).toEqual({ netLong, netShort, netFlat });
    expect(idx.byPositionCount).toEqual({ longCount, shortCount });
    expect(near(idx.byNotional.longNotional, longN, 2)).toBeTruthy();
    expect(near(idx.byNotional.shortNotional, shortN, 2)).toBeTruthy();
    expect(near(idx.byNotional.longPct, longN / Math.max(1, longN + shortN), 0.0002)).toBeTruthy();
    expect(near(idx.participationRate, holdersWithPosition / idx.holdersTotal, 0.0002)).toBeTruthy();

    // topCoins: the 15 biggest books, ordered, with matching per-coin numbers.
    const ranked = [...coins.entries()].sort((a, b) => (b[1].ln + b[1].sn) - (a[1].ln + a[1].sn)).slice(0, 15);
    expect(idx.topCoins.map((c) => c.coin)).toEqual(ranked.map(([c]) => c));
    for (const row of idx.topCoins) {
      const c = coins.get(row.coin);
      expect(row.longWallets, `${row.coin} longWallets`).toBe(c.lw.size);
      expect(row.shortWallets, `${row.coin} shortWallets`).toBe(c.sw.size);
      expect(row.holders, `${row.coin} holders`).toBe(new Set([...c.lw, ...c.sw]).size);
      expect(near(row.longNotional, c.ln, 2), `${row.coin} longNotional`).toBeTruthy();
      expect(near(row.shortNotional, c.sn, 2), `${row.coin} shortNotional`).toBeTruthy();
      expect(row.netDir).toBe(c.ln >= c.sn ? 'long' : 'short');
    }
  });

  test('cat_states.json matches each owner net stance', async ({ request, baseURL }) => {
    const [states, pos, owners, idx] = await Promise.all([
      getJSON(request, baseURL, 'cat_states.json'), getJSON(request, baseURL, 'positions.json'),
      getJSON(request, baseURL, 'owners.json'), getJSON(request, baseURL, 'index.json'),
    ]);
    expect(states.states).toHaveLength(SUPPLY);
    expect(/^[0-3]+$/.test(states.states), 'state chars outside 0-3').toBeTruthy();
    expect(states.generatedAt).toBe(pos.generatedAt);

    let awake = 0, unread = 0, mismatches = [];
    for (let id = 1; id <= SUPPLY; id++) {
      const w = pos.wallets[owners[id]];
      let want;
      if (w && w.error) { want = '3'; unread++; }
      else if (!w || !w.hasPosition) want = '0';
      else {
        let net = 0;
        for (const p of w.positions) net += (p.direction === 'long' ? 1 : -1) * p.notionalUsd;
        want = net >= 0 ? '1' : '2';
        awake++;
      }
      if (states.states[id - 1] !== want && mismatches.length < 5) mismatches.push(`#${id} is ${states.states[id - 1]}, expected ${want}`);
    }
    expect(mismatches).toEqual([]);
    expect(states.awakeTokens).toBe(awake);
    expect(states.unreadTokens).toBe(unread);
    expect(idx.awakeTokens, 'index.json awakeTokens').toBe(awake);
  });

  test('desk.json rows agree with positions.json', async ({ request, baseURL }) => {
    const [desk, pos, owners, tokens] = await Promise.all([
      getJSON(request, baseURL, 'desk.json'), getJSON(request, baseURL, 'positions.json'),
      getJSON(request, baseURL, 'owners.json'), getJSON(request, baseURL, 'tokens.json'),
    ]);
    const rrOf = Object.fromEntries(tokens.tokens.map((t) => [t.id, t.rr]));
    const heldBy = {};
    for (const [id, a] of Object.entries(owners)) (heldBy[a] ||= []).push(+id);

    expect(desk.rows.length).toBeLessThanOrEqual(200);
    expect(desk.rows.length).toBeGreaterThan(0);

    const problems = [];
    let prev = Infinity;
    for (const r of desk.rows) {
      const w = pos.wallets[r.owner];
      if (!w || !w.hasPosition) { problems.push(`${r.owner}: on the desk without a live position`); continue; }
      if (r.totalNotional > prev) problems.push(`${r.owner}: rows not sorted by notional`);
      prev = r.totalNotional;
      const total = w.positions.reduce((s, p) => s + p.notionalUsd, 0);
      const net = w.positions.reduce((s, p) => s + (p.direction === 'long' ? 1 : -1) * p.notionalUsd, 0);
      if (!near(r.totalNotional, total, 2)) problems.push(`${r.owner}: totalNotional ${r.totalNotional} vs ${total}`);
      if (!near(r.netNotional, net, 2)) problems.push(`${r.owner}: netNotional ${r.netNotional} vs ${net}`);
      if (r.posCount !== w.positions.length) problems.push(`${r.owner}: posCount ${r.posCount} vs ${w.positions.length}`);
      if (r.positions.length > 12) problems.push(`${r.owner}: more than 12 legs embedded`);
      const held = heldBy[r.owner] || [];
      if (!held.includes(r.id)) problems.push(`${r.owner}: representative #${r.id} not held`);
      const rarest = held.slice().sort((a, b) => rrOf[a] - rrOf[b])[0];
      if (r.id !== rarest) problems.push(`${r.owner}: representative #${r.id} is not the rarest held (#${rarest})`);
      if (r.heldCount !== held.length) problems.push(`${r.owner}: heldCount ${r.heldCount} vs ${held.length}`);
      // the coin filter reads this list, so it must cover the WHOLE book
      const coins = new Set(w.positions.map((p) => p.coin));
      if (!r.coins || r.coins.length !== coins.size) problems.push(`${r.owner}: coins list covers ${r.coins?.length} of ${coins.size}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(desk.holdersWithPosition).toBe(Object.values(pos.wallets).filter((w) => w.hasPosition).length);
  });

  test('og.json (The Pride) recomputes from provenance', async ({ request, baseURL }) => {
    const [og, prov, owners] = await Promise.all([
      getJSON(request, baseURL, 'og.json'), getJSON(request, baseURL, 'provenance.json'),
      getJSON(request, baseURL, 'owners.json'),
    ]);
    let neverTraded = 0, totalTrades = 0, totalTransfers = 0;
    const neverOwners = new Set();
    for (const [id, p] of Object.entries(prov.prov)) {
      totalTrades += p.trades || 0;
      totalTransfers += (p.chain || []).length;
      if ((p.trades || 0) === 0) { neverTraded++; neverOwners.add(p.currentOwner); }
    }
    expect(og.stats.supply).toBe(SUPPLY);
    expect(og.stats.neverTraded).toBe(neverTraded);
    expect(og.stats.tradedCats).toBe(SUPPLY - neverTraded);
    expect(og.stats.totalTrades).toBe(totalTrades);
    expect(og.stats.totalTransfers).toBe(totalTransfers);
    expect(og.stats.diamondWallets, 'distinct wallets holding a never-traded Hypurr').toBe(neverOwners.size);
    expect(og.diamonds).toHaveLength(neverTraded);
    // Every listed diamond really has never traded and is still owned by that wallet.
    const fake = og.diamonds.filter((d) => (prov.prov[d.id]?.trades || 0) !== 0 || owners[d.id] !== d.owner).slice(0, 5);
    expect(fake, 'diamonds that have traded or changed hands').toEqual([]);
    // most-flipped headline must be the actual maximum
    const maxFlips = Math.max(...Object.values(prov.prov).map((p) => p.trades || 0));
    expect(og.stats.mostFlipped.flips).toBe(maxFlips);
    expect(prov.prov[og.stats.mostFlipped.id].trades).toBe(maxFlips);
    expect(og.flipped[0].flips).toBe(maxFlips);
  });

  test('sales and scatter are consistent and plausible', async ({ request, baseURL }) => {
    const [sales, scatter, tokens] = await Promise.all([
      getJSON(request, baseURL, 'sales.json'), getJSON(request, baseURL, 'scatter.json'),
      getJSON(request, baseURL, 'tokens.json'),
    ]);
    const rrOf = Object.fromEntries(tokens.tokens.map((t) => [t.id, t.rr]));
    let count = 0, vol = 0, maxP = 0, minP = Infinity, lastTs = 0;
    const problems = [];
    for (const [id, arr] of Object.entries(sales.byToken)) {
      if (+id < 1 || +id > SUPPLY) problems.push(`sale for out-of-range token ${id}`);
      let prevTs = 0;
      for (const s of arr) {
        count++; vol += s.price;
        maxP = Math.max(maxP, s.price); minP = Math.min(minP, s.price); lastTs = Math.max(lastTs, s.ts);
        if (!(s.price > 0)) problems.push(`#${id}: non-positive price ${s.price}`);
        if (s.ts < 1_700_000_000 || s.ts > Date.now() / 1000 + 3600) problems.push(`#${id}: implausible ts ${s.ts}`);
        if (s.ts < prevTs) problems.push(`#${id}: sales out of order`);
        prevTs = s.ts;
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(sales.stats.totalSales).toBe(count);
    expect(sales.stats.tokensWithSale).toBe(Object.keys(sales.byToken).length);
    expect(near(sales.stats.totalVolumeHype, Math.round(vol), 2)).toBeTruthy();
    expect(sales.stats.maxPriceHype).toBe(Math.round(maxP));
    expect(sales.stats.lastSaleTs).toBe(lastTs);

    // scatter = last sale price per token, with the right rarity rank
    expect(scatter.pts).toHaveLength(Object.keys(sales.byToken).length);
    const bad = scatter.pts.filter((p) => {
      const arr = sales.byToken[p.id];
      return !arr || arr[arr.length - 1].price !== p.p || rrOf[p.id] !== p.rr;
    }).slice(0, 5);
    expect(bad, 'scatter points that do not match the last sale').toEqual([]);
  });

  test('history and HYPE price series are sane', async ({ request, baseURL }) => {
    const [hist, hype, idx] = await Promise.all([
      getJSON(request, baseURL, 'history.json'), getJSON(request, baseURL, 'hype_price.json'),
      getJSON(request, baseURL, 'index.json'),
    ]);
    expect(hist.points.length).toBeGreaterThan(1);
    expect(hist.points.length).toBeLessThanOrEqual(8800);
    const outOfOrder = hist.points.filter((p, i) => i && p.t < hist.points[i - 1].t).length;
    expect(outOfOrder, 'history points out of chronological order').toBe(0);
    const badPoint = hist.points.filter((p) => !(p.lp >= 0 && p.lp <= 1) || p.live < 0 || p.nl < 0 || p.ns < 0).slice(0, 3);
    expect(badPoint).toEqual([]);
    // the newest point must be this cycle's numbers
    const last = hist.points[hist.points.length - 1];
    expect(last.live).toBe(idx.holdersWithPosition);
    expect(last.nl).toBe(idx.byWallet.netLong);
    expect(near(last.lp, idx.byNotional.longPct, 0.0002)).toBeTruthy();

    for (const series of ['px', 'pxh']) {
      const s = hype[series];
      expect(s.length, `${series} empty`).toBeGreaterThan(0);
      expect(s.filter((c, i) => i && c.t < s[i - 1].t).length, `${series} out of order`).toBe(0);
      expect(s.every((c) => c.c > 0 && c.c < 10_000), `${series} implausible price`).toBeTruthy();
    }
    if (IS_LIVE) expect(ageMinutes(hype.updated), 'hype_price.json age').toBeLessThan(MAX_AGE_MIN);
  });

  test('leaderboards reference real, live wallets', async ({ request, baseURL }) => {
    const [lead, desk, pos] = await Promise.all([
      getJSON(request, baseURL, 'leaders.json'), getJSON(request, baseURL, 'desk.json'),
      getJSON(request, baseURL, 'positions.json'),
    ]);
    const byOwner = Object.fromEntries(desk.rows.map((r) => [r.owner, r]));
    const problems = [];
    for (const board of ['biggest', 'diversified', 'contrarians']) {
      expect(lead[board].length, `${board} board empty`).toBeGreaterThan(0);
      for (const e of lead[board]) {
        if (!isAddress(e.owner)) problems.push(`${board}: bad address ${e.owner}`);
        const w = pos.wallets[e.owner];
        if (!w || !w.hasPosition) problems.push(`${board}: ${e.owner} has no live position`);
        const row = byOwner[e.owner];
        if (row && !near(e.notional, row.totalNotional, 2)) problems.push(`${board}: ${e.owner} notional drift`);
      }
    }
    // biggest must actually be the biggest, diversified the widest
    const sortedBig = [...lead.biggest].sort((a, b) => b.notional - a.notional).map((e) => e.owner);
    expect(lead.biggest.map((e) => e.owner)).toEqual(sortedBig);
    const sortedDiv = [...lead.diversified].sort((a, b) => b.coins - a.coins).map((e) => e.owner);
    expect(lead.diversified.map((e) => e.owner)).toEqual(sortedDiv);
    // contrarians must lean against the crowd
    for (const e of lead.contrarians) {
      const row = byOwner[e.owner];
      if (!row) continue;
      if (lead.crowd === 'long' ? row.netNotional >= 0 : row.netNotional <= 0) problems.push(`contrarian ${e.owner} leans with the crowd`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  test('globe ids are real tokens with cached art', async ({ request, baseURL }) => {
    const globe = await getJSON(request, baseURL, 'globe.json');
    expect(globe.ids.length).toBeGreaterThan(50);
    expect(globe.ids.every((id) => id >= 1 && id <= SUPPLY)).toBeTruthy();
    const sample = globe.ids.slice(0, 8);
    for (const id of sample) {
      const r = await request.get(`${baseURL}/img/${id}.webp`);
      expect(r.status(), `/img/${id}.webp`).toBe(200);
    }
  });

  test('every data timestamp comes from the same refresh cycle', async ({ request, baseURL }) => {
    const stamped = ['index.json', 'positions.json', 'desk.json', 'cat_states.json', 'leaders.json', 'history.json', 'hype_price.json'];
    const stamps = {};
    for (const f of stamped) {
      const d = await getJSON(request, baseURL, f);
      stamps[f] = d.generatedAt || d.updated;
    }
    const ages = Object.entries(stamps).map(([f, t]) => [f, Math.round(ageMinutes(t))]);
    if (IS_LIVE) {
      const stale = ages.filter(([, a]) => a > MAX_AGE_MIN);
      expect(stale, `stale data (minutes old, limit ${MAX_AGE_MIN}): ${JSON.stringify(ages)}`).toEqual([]);
    }
    expect(new Set(Object.values(stamps)).size, `cycle stamps disagree: ${JSON.stringify(stamps)}`).toBe(1);
  });
});
