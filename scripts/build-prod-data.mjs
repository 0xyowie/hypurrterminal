// Build the genuinely STATIC production data into site/data/.
//
// Scope, deliberately narrow: tokens.json, rarity.json, globe.json. Those three are
// derived from the frozen metadata snapshot in data/ and never change.
//
// This script used to also write owners.json, provenance.json, sales.json and og.json.
// It must not. Those four are owned by scripts/refresh-prod.mjs, which rebuilds them
// from the chain every cron run. data/ is a July snapshot, so re-running this after a
// refresh silently rolled production back weeks: owners reverted, sale history was
// truncated, The Pride showed stale diamonds. Anything the chain can change belongs to
// the cron, and only to the cron.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// fileURLToPath, not url.pathname: a pathname keeps its percent-encoding, so a
// checkout under a folder with a space in it resolves to "Perps%20trading" and every
// read fails with ENOENT. The CI runner has no spaces in its path and never saw this.
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const D = path.join(ROOT, "data");
const OUT = path.join(ROOT, "site/data");
fs.mkdirSync(OUT, { recursive: true });
const rd = f => JSON.parse(fs.readFileSync(path.join(D, f)));
const wr = (f, o) => { fs.writeFileSync(path.join(OUT, f), JSON.stringify(o)); return (fs.statSync(path.join(OUT, f)).size/1024).toFixed(0)+"KB"; };

// Files this script is NOT allowed to touch, and the script that owns each of them.
const CRON_OWNED = ["owners.json", "provenance.json", "sales.json", "og.json",
  "positions.json", "desk.json", "index.json", "cat_states.json", "flips.json",
  "leaders.json", "history.json", "hype_price.json", "scatter.json", "chainstate.json"];

const traits = rd("traits.json");
const freq = rd("trait_freq.json");

// tokens.json — {id, rr, t} (name derived as "Hypurr #id")
const tokens = traits.tokens.map(t => ({ id: t.id, rr: t.rarityRank, t: t.traits }));
console.log("tokens.json", wr("tokens.json", { supply: 4600, tokens }));

// rarity.json (trait frequencies)
console.log("rarity.json", wr("rarity.json", { total: freq.total, categories: freq.categories, freq: freq.freq }));

// globe.json — ~140 ids spread across the collection
const N = 140, step = Math.floor(4600/N);
const globe = Array.from({length:N},(_,i)=> traits.tokens[i*step]?.id).filter(Boolean);
console.log("globe.json", wr("globe.json", { ids: globe }));

console.log(`\nwrote 3 static files. Left untouched (owned by scripts/refresh-prod.mjs):`);
console.log(`  ${CRON_OWNED.join(", ")}`);
console.log(`Run scripts/refresh-prod.mjs to rebuild those from the chain.`);
