# Hypurr Terminal

An unofficial, community-built dashboard for the [Hypurr](https://hyperliquid.xyz) NFT collection (4,600 Hyperliquid OGs on HyperEVM). It cross-references each Hypurr's owner wallet with that wallet's **live Hyperliquid positioning** — the traders behind the art.

Live at **[hypurrterminal.xyz](https://hypurrterminal.xyz)**.

Direction, coin, size, notional and leverage only — **never PnL**, never balances. Many holders run delta-neutral or hedged books, so nothing here is a signal or financial advice.

## Structure

- `site/` — the deployable static site (Cloudflare Pages output directory)
  - `*.html` — pages (landing, collection, positioning/The Index, desk, pride, privacy)
  - `assets/` — shared `base.css`, `app.js` (consent-gated GA), `three.min.js`
  - `data/` — JSON the pages fetch (static + refreshed)
  - `img/` — 4,600 cached Hypurr thumbnails (WebP)
- `scripts/` — data build + refresh scripts
- `data/` — source data used by the build scripts

## Data refresh

`.github/workflows/refresh.yml` runs `scripts/refresh-prod.mjs` every ~15 minutes: it sweeps every holder wallet's `clearinghouseState` from the Hyperliquid public API and rewrites `site/data/positions.json`, `index.json`, and `desk.json`, then commits. Cloudflare Pages redeploys on push.

Rebuild the static data with `node scripts/build-prod-data.mjs`; re-cache images with `node scripts/cache-images.mjs`.

## Deploy (Cloudflare Pages)

Connect this repo to Cloudflare Pages with:
- **Build command:** *(none)*
- **Build output directory:** `site`
- **Production branch:** `main`

Then add `hypurrterminal.xyz` as a custom domain (DNS is automatic since the domain is on Cloudflare).
