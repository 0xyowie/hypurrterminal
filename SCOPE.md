# Hypurr Terminal — "The Living Pride" roadmap

North star: **the site is not a gallery of the pride — it *is* the pride, and the market is its weather.**
Every phase must ship mobile-seamless: same experience philosophy, tuned budgets.

## Cross-cutting rules (every phase)

- **Mobile is a first-class target**, not a fallback: touch gestures never fight page scroll
  (`touch-action: pan-y`, horizontal-only drags), particle/texture budgets scale with device,
  DPR capped (1.5 mobile / 2 desktop), tap targets ≥ 40px.
- **Progressive loading choreography**: text paints instantly; atmosphere fades in.
  Heavy assets (atlases, video plates) load after first paint; the scene starts as colored
  embers (tiny JSON) and *resolves* into art when the atlas arrives — the loading state is
  itself a designed moment.
- **Graceful degradation**: `prefers-reduced-motion` → composed static scene, no RAF loop.
  No WebGL → gradient + typographic hero. Old phones → reduced particle count, small atlas.
- **No PnL, ever.** Direction/coin/size/notional/leverage only (existing hard rule).
- **Perf gates**: 60fps desktop / ≥40fps mid-tier phone on the hero; LCP < 2.5s; landing
  critical path < 150KB before atmosphere assets.

## Phase 1 — The Living Hero + Market Weather  *(SHIPPED)*

The flagship thesis piece. The landing hero becomes an instanced-WebGL particle field where
**each particle is a real Hypurr** (texture-atlas billboards), and the field physically
reorganizes into the data as you scroll.

- `scripts/build-atlas.mjs`: pack 4,600 thumbs into `site/assets/atlas48.webp` (desktop)
  and `atlas24.webp` (mobile), 68×68 grid + `atlas_meta.json` (grid + per-cat avg color).
- `refresh-prod.mjs` additionally emits `cat_states.json` — per-cat trading stance
  (0 flat / 1 long / 2 short, from owner's net side) — 4,600 chars, refreshed every 15 min.
- Custom shader engine (three.js base): instanced quads, per-particle spring-eased morph
  between formation target buffers with stagger; curl-ish idle drift; ember→art resolve;
  awake cats glow mint and pulse.
- **Formations / scroll beats** (CSS sticky pinning, works natively on mobile):
  1. *Nebula* — "The pride never sleeps." (CTA visible immediately)
  2. *Rarity spiral* — "4,600 dealt in one night."
  3. *Long/short columns built from the cats themselves* — "Right now the pride leans X% long." (live)
  4. *Awake surge / paw* — "N awake on the tape right now." → strip nav
- **Market weather**: global tint + drift energy driven by live index.json — warm ember
  palette when the pride leans long, cool moonlit teal when short. The site feels different
  on different days.
- Touch: horizontal drag spins the field; vertical scrolls the story. Pointer parallax on desktop.

## Phase 2 — The Share Layer (distribution)  *(SHIPPED — 4,600 static /cat pages + canvas share cards; Daily Pulse history accumulating; X auto-post deferred)*

- **Cat passports**: `/cat/:id` permalinks (Cloudflare Pages function or client route) with
  per-cat OG unfurls (art + rarity + last sale + stance in title/desc). In-browser
  canvas-composed passport card (art, rarity rank, provenance timeline, owner stance) with
  Web Share API on mobile / download on desktop. Zero server image generation.
- **Daily Pulse**: cron appends each 15-min index snapshot to `site/data/history.json`;
  a daily digest entry + one `pulse.png` share card (sharp, 1/day, committed). `/pulse` page
  with the archive. Optional later: auto-post to X (needs user's X API keys).

## Phase 3 — Alpha Layer (retention)  *(SHIPPED — /pulse chart+boards+scatter, /wallet lookup; leaders.json in cron)*

- **Sentiment history chart** on /pulse and The Index: pride net-long % over time overlaid
  with HYPE price (candles from the Hyperliquid public API, fetched by the cron).
- **Wallet lookup** `/wallet`: paste any address → its Hypurrs + live stance. No connect.
- **Leaderboards**: biggest book, most diversified, longest diamond streak, "the contrarian"
  (most positioned against the crowd) — computed in the cron → `leaders.json`.
- **Trait value analytics**: rarity rank vs last-sale scatter ("undervalued rarity"),
  median sale by trait, on The Collection or its own tab.

## Phase 4 — The Observatory (showpiece)  *(SHIPPED — PCA trait-space 3D at /observatory, orbit+pinch+fly-to)*

All 4,600 explorable in 3D: one-hot trait vectors → PCA/UMAP precomputed at build →
cats cluster into visual-family neighborhoods you fly through. Reuses the Phase-1 atlas
engine. Desktop free-fly + search-to-fly; mobile orbit + pinch with simplified density.

## Phase 5 — Cinematic Layer *(needs wavespeed/kie credits)*

- Style-matched **den environment paintings** (GPT Image, seeded with real Hypurr thumbs as
  style refs) → **Kling seamless loops** → compressed WebM plates layered *under* the
  particle field (video richness + interactive particles reading as one scene).
- Hand-lettered **HYPURR wordmark** (generated, traced to SVG, stroke draw-on animation).
- Optional, off-by-default **ambient sound toggle** (den ambience; purr on hovering a
  trading cat).
- Variable-type moments: display weight breathing with net-long %.

## Sequencing

P1 → P2 → P3 → P4, with P5 running opportunistically once credits/keys are available
(its assets slot under the P1 engine without rework).
