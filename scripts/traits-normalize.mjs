// Some Hypurrs simply have no Clothing / Eyes / Background key in the source
// metadata, while other categories spell the same thing out as "None". That
// inconsistency leaked into the site: the Clothing frequency table summed to 4,585 of
// 4,600, so "x% have this trait" was measured against a different denominator per
// category, and no filter could reach the 15 Hypurrs wearing nothing.
//
// Absence IS a trait here, so make it explicit once, at build time, for both the token
// list and the frequency table. The frozen snapshot in data/ is left untouched.

export const NONE = "None";

export function normalizeTraits(tokens, categories, traitsKey = "traits") {
  const added = {};
  for (const t of tokens) {
    const map = t[traitsKey];
    if (!map) continue;
    for (const cat of categories) {
      if (map[cat] === undefined) { map[cat] = NONE; added[cat] = (added[cat] || 0) + 1; }
    }
  }
  return added;
}

export function normalizeFreq(freq, categories, added) {
  for (const cat of categories) {
    if (!added[cat]) continue;
    freq[cat] = freq[cat] || {};
    freq[cat][NONE] = (freq[cat][NONE] || 0) + added[cat];
  }
  return freq;
}
