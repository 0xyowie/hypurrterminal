// Build STATIC production data into site/data/ (rarely-changing files).
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const D = path.join(ROOT, "data");
const OUT = path.join(ROOT, "site/data");
fs.mkdirSync(OUT, { recursive: true });
const rd = f => JSON.parse(fs.readFileSync(path.join(D, f)));
const wr = (f, o) => { fs.writeFileSync(path.join(OUT, f), JSON.stringify(o)); return (fs.statSync(path.join(OUT, f)).size/1024).toFixed(0)+"KB"; };

const traits = rd("traits.json");
const freq = rd("trait_freq.json");
const ownersRaw = rd("owners.json").owners;      // {id: owner}
const provAll = rd("provenance_all.json");
const prov = provAll.prov;                         // {id: {airdropTs,currentOwner,trades,chain}}
const sales = rd("sales.json");
const transfersMeta = (()=>{ try { return rd("transfers_raw.json").transfers.length; } catch { return 18928; } })();

// tokens.json — {id, rr, t} (name derived as "Hypurr #id")
const tokens = traits.tokens.map(t => ({ id: t.id, rr: t.rarityRank, t: t.traits }));
console.log("tokens.json", wr("tokens.json", { supply: 4600, tokens }));

// rarity.json (trait frequencies)
console.log("rarity.json", wr("rarity.json", { total: freq.total, categories: freq.categories, freq: freq.freq }));

// owners.json {id: owner}
console.log("owners.json", wr("owners.json", ownersRaw));

// provenance.json
console.log("provenance.json", wr("provenance.json", { nowTs: provAll.nowTs, prov }));

// sales.json
console.log("sales.json", wr("sales.json", sales));

// ---- og.json (The Pride) : diamonds + flipped + stats ----
const rrOf = {}; traits.tokens.forEach(t => rrOf[t.id] = t.rarityRank);
// invert owners -> owner: [ids]
const heldBy = {}; for (const id in ownersRaw){ (heldBy[ownersRaw[id]] ||= []).push(+id); }
// never-traded tokens grouped by current owner
const neverByOwner = {}; let neverTraded = 0, totalTrades = 0;
for (const id in prov){ const p = prov[id]; totalTrades += p.trades; if (p.trades === 0){ neverTraded++; (neverByOwner[p.currentOwner] ||= []).push(+id); } }
const diamonds = Object.entries(neverByOwner).map(([owner, ids]) => {
  const rep = ids.slice().sort((a,b)=> rrOf[a]-rrOf[b])[0]; // rarest never-traded held
  return { owner, diamondCount: ids.length, heldCount: (heldBy[owner]||[]).length, id: rep, rarityRank: rrOf[rep] };
}).sort((a,b)=> b.diamondCount - a.diamondCount || a.rarityRank - b.rarityRank).slice(0, 120);
// most flipped tokens
const flipped = Object.keys(prov).map(id => ({ id:+id, flips: prov[id].trades, rarityRank: rrOf[id], owner: prov[id].currentOwner }))
  .sort((a,b)=> b.flips - a.flips || a.rarityRank - b.rarityRank).slice(0, 90);
const diamondWallets = Object.keys(neverByOwner).length;
const airdropTs = prov["1"]?.airdropTs || 1759074300;
const daysSinceAirdrop = Math.floor((Date.now()/1000 - airdropTs)/86400);
const og = {
  stats: {
    supply: 4600, diamondWallets, neverTraded, tradedCats: 4600 - neverTraded,
    totalTrades, totalTransfers: transfersMeta,
    mostFlipped: { id: flipped[0].id, flips: flipped[0].flips },
    airdropDate: new Date(airdropTs*1000).toISOString().slice(0,10), daysSinceAirdrop,
  },
  diamonds, flipped,
};
console.log("og.json", wr("og.json", og));

// globe.json — ~140 ids spread across the collection
const N = 140, step = Math.floor(4600/N);
const globe = Array.from({length:N},(_,i)=> traits.tokens[i*step]?.id).filter(Boolean);
console.log("globe.json", wr("globe.json", { ids: globe }));

console.log(`\nstats: neverTraded ${neverTraded}, diamondWallets ${diamondWallets}, totalTrades ${totalTrades}, mostFlipped #${flipped[0].id} (${flipped[0].flips}x)`);
