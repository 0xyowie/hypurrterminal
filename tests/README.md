# Hypurr Terminal test suite

End-to-end checks for the site, the data it ships and the pipeline that refreshes it.
Playwright drives everything; there is nothing to configure beyond `npm install`.

```bash
npm install                 # installs @playwright/test + axe-core
npx playwright install chromium

npm test                    # local: serves site/ and runs everything
npm run test:live           # same suite against https://hypurrterminal.xyz
npm run test:data           # data + live-truth only (fast, no browser rendering)
npm run test:report         # open the last HTML report
```

## What each spec covers

| Spec | Question it answers |
| --- | --- |
| `01-pages` | Does every route load, fill with data, and do it without console or network errors? Redirects, 404, every internal link, nav state, consent-gated GA. |
| `02-data` | Is the shipped JSON well-formed, internally consistent and fresh? Recomputes `index.json`, `desk.json`, `cat_states.json`, `og.json` and `scatter.json` from their sources. Enforces the no-PnL rule. |
| `03-live-truth` | Are the numbers actually true? Spot-checks wallets against Hyperliquid `clearinghouseState`, coins against `meta`, HYPE price against `allMids`, ownership against HyperEVM `ownerOf`. |
| `04-interactions` | Search, sort, filters, modals, keyboard activation, wallet lookup, charts, passport share card. |
| `05-mobile` | iPhone viewport: horizontal overflow, hamburger, tap targets, scroll vs drag on the hero, mobile atlas budget, back-gesture closing a sheet. |
| `06-a11y` | axe-core (WCAG 2.1 AA) per page, plus landmarks, alt text, keyboard reach, focus trap and return, reduced motion. |
| `07-perf` | FCP/LCP budgets, landing critical path in KB, hero frame rate, lazy loading, no-WebGL fallback, a stalled font CDN, edge compression and cache headers. |
| `08-seo` | Titles, descriptions, canonicals, OG/Twitter unfurls (pages and passports), og.png dimensions, robots, both sitemaps, disclaimer coverage, no PnL wording on screen. |
| `09-pipeline` | Workflow file sanity, the guards inside `refresh-prod.mjs`, data freshness, refresh cadence and blackouts, recent Actions runs, live-vs-repo deploy lag. |

## Environment knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `TARGET` | `local` | `local` serves `site/` on `PORT`; `live` points at `LIVE_URL`. |
| `LIVE_URL` | `https://hypurrterminal.xyz` | Production base URL. |
| `PORT` | `4173` | Local static server port. |
| `MAX_DATA_AGE_MIN` | `180` | Freshness alarm for the refresh cycle. |
| `LCP_BUDGET_MS` / `CRITICAL_KB` / `FPS_FLOOR` | `2500` / `150` / `45` | Performance budgets from SCOPE.md. |
| `TRUTH_SAMPLE` | `12` | Wallets spot-checked against Hyperliquid. |
| `PW_CHROMIUM` | — | Use a system Chromium instead of Playwright's download. |
| `BROWSER` | `chromium` | Set to `webkit` for a real Safari pass (`npx playwright install webkit` first). |
| `GH_REPO` | `0xyowie/hypurrterminal` | Repo queried for Actions health. |

## Notes

- The suite reads production data over the network, so a few tests are inherently
  time-sensitive: `03-live-truth` skips its position comparison when the snapshot is
  more than 45 minutes old, because at that point it would be measuring the delay,
  not the correctness.
- Google Fonts is blocked during performance measurement so the numbers describe the
  site's own critical path. One dedicated test stalls that CDN on purpose to check the
  page still paints.
- Data specs run against whatever `TARGET` points at, so `npm run test:data` doubles
  as a production monitor.
