// Performance budgets from SCOPE.md: LCP < 2.5s, landing critical path < 150KB
// before atmosphere assets, 60fps desktop hero, graceful degradation without WebGL.
import { test, expect } from '@playwright/test';
import { PAGES, seedConsent, isThirdParty } from '../helpers/util.mjs';

const LCP_BUDGET_MS = Number(process.env.LCP_BUDGET_MS || 2500);
const CRITICAL_KB = Number(process.env.CRITICAL_KB || 150);
const FPS_FLOOR = Number(process.env.FPS_FLOOR || 45);

test.beforeEach(async ({ context }) => { await seedConsent(context); });

// Google Fonts is a third party the site cannot control, and in CI it is often
// unreachable. Cut it out so the numbers describe the site's own critical path.
async function blockFonts(page) {
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
}

async function measure(page, path) {
  const bytes = { total: 0, critical: 0, byType: {} };
  page.on('response', (r) => {
    if (isThirdParty(r.url())) return;
    const len = Number(r.headers()['content-length'] || 0);
    const type = r.request().resourceType();
    bytes.total += len;
    bytes.byType[type] = (bytes.byType[type] || 0) + len;
    // "critical path" = what blocks first paint: the document, its CSS and its
    // synchronous JS. Atlases, art and data arrive after.
    if (['document', 'stylesheet', 'script'].includes(type) && !/atlas|three\.min/.test(r.url())) bytes.critical += len;
  });

  await page.goto(path, { waitUntil: 'load' });
  const lcp = await page.evaluate(() => new Promise((res) => {
    let value = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) value = e.startTime; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { res(null); return; }
    setTimeout(() => res(value), 3500);
  }));
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { domContentLoaded: n?.domContentLoadedEventEnd, load: n?.loadEventEnd, fcp: fcp?.startTime || null };
  });
  return { bytes, lcp, nav };
}

for (const p of PAGES) {
  test(`perf ${p.name}: LCP and paint budgets`, async ({ page }) => {
    await blockFonts(page);
    const m = await measure(page, p.path);
    console.log(`${p.path}: FCP ${Math.round(m.nav.fcp)}ms, LCP ${Math.round(m.lcp)}ms, ${Math.round(m.bytes.total / 1024)}KB`);
    expect(m.nav.fcp, `${p.path} first contentful paint (ms)`).toBeLessThan(2000);
    expect(m.lcp, `${p.path} LCP (ms) — budget ${LCP_BUDGET_MS}`).toBeLessThan(LCP_BUDGET_MS);
  });
}

test('perf landing: critical path stays under budget', async ({ page }) => {
  await blockFonts(page);
  const m = await measure(page, '/');
  const kb = Math.round(m.bytes.critical / 1024);
  console.log(`landing bytes: ${JSON.stringify(m.bytes.byType)}`);
  expect(kb, `landing critical path ${kb}KB (budget ${CRITICAL_KB}KB)`).toBeLessThan(CRITICAL_KB);
});

test('perf: a slow Google Fonts must not hold up first paint', async ({ page }) => {
  // The font stylesheet is render-blocking. If the CDN hangs, does the page still
  // paint? Simulate a 10s stall — the site should have painted long before.
  await page.route('**://fonts.googleapis.com/**', async (r) => {
    await new Promise((res) => setTimeout(res, 10_000));
    await r.abort();
  });
  await page.goto('/', { waitUntil: 'commit' });
  const fcp = await page.evaluate(() => new Promise((res) => {
    const done = () => {
      const e = performance.getEntriesByName('first-contentful-paint')[0];
      if (e) res(e.startTime); else setTimeout(done, 100);
    };
    setTimeout(() => res(null), 8000);
    done();
  }));
  expect(fcp, 'page did not paint within 8s while the font CDN hung').not.toBeNull();
  expect(fcp, `first paint waited ${Math.round(fcp)}ms on the font CDN`).toBeLessThan(2500);
});

test('perf landing: the hero holds frame rate', async ({ page }) => {
  await blockFonts(page);
  await page.goto('/');
  const renderer = await page.evaluate(() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    } catch { return 'none'; }
  });
  test.skip(/swiftshader|llvmpipe|software/i.test(renderer), `software rasterizer (${renderer}) — frame rate here is meaningless`);

  await page.waitForTimeout(5000); // let the atlas resolve
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; const dt = performance.now() - t0; if (dt < 3000) requestAnimationFrame(tick); else res(n / (dt / 1000)); };
    requestAnimationFrame(tick);
  }));
  console.log(`hero: ${Math.round(fps)}fps on ${renderer}`);
  expect(Math.round(fps), `hero frame rate ${Math.round(fps)}fps (floor ${FPS_FLOOR})`).toBeGreaterThan(FPS_FLOOR);
});

test('perf: art is lazy-loaded, not 4,600 requests at once', async ({ page }) => {
  let imgRequests = 0;
  page.on('request', (r) => { if (r.resourceType() === 'image' && r.url().includes('/img/')) imgRequests++; });
  await page.goto('/collection');
  await page.waitForTimeout(4000);
  console.log(`collection requested ${imgRequests} thumbnails before scrolling`);
  expect(imgRequests, 'thumbnails requested before scrolling').toBeLessThan(400);

  const lazy = await page.$$eval('#grid img', (imgs) => imgs.slice(0, 20).map((i) => i.getAttribute('loading')));
  expect(lazy.filter((l) => l !== 'lazy').length, 'grid images without loading="lazy"').toBeLessThanOrEqual(lazy.length * 0.2);
});

test('perf: no-WebGL degrades gracefully', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('hypurr_cookie_consent', 'declined'); } catch {}
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (String(type).includes('webgl')) return null;
      return orig.call(this, type, ...rest);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  await expect(page.locator('h1, .beat .h').first()).toBeVisible();
  const text = await page.evaluate(() => document.body.innerText.trim().length);
  expect(text, 'landing is blank without WebGL').toBeGreaterThan(120);
  expect(errors, 'uncaught errors when WebGL is unavailable').toEqual([]);
  await ctx.close();
});

test('perf: assets are served compressed and cacheable', async ({ request, baseURL }) => {
  test.skip(process.env.TARGET !== 'live', 'edge headers only exist in production');
  const checks = ['/assets/base.css', '/assets/app.js', '/assets/three.min.js', '/data/index.json', '/'];
  const problems = [];
  for (const url of checks) {
    const res = await request.get(baseURL + url, { headers: { 'accept-encoding': 'gzip, br' } });
    if (!res.ok()) { problems.push(`${url}: HTTP ${res.status()}`); continue; }
    const h = res.headers();
    const body = await res.body();
    if (!h['content-encoding'] && body.length > 4096) problems.push(`${url}: served uncompressed (${Math.round(body.length / 1024)}KB)`);
    if (!h['cache-control']) problems.push(`${url}: no cache-control`);
    if (url.endsWith('.json')) {
      const maxAge = Number((h['cache-control'] || '').match(/max-age=(\d+)/)?.[1] || 0);
      if (maxAge > 900) problems.push(`${url}: live data cached ${maxAge}s at the edge`);
    }
  }
  expect(problems).toEqual([]);
});
