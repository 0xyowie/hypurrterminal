// Metadata, unfurls and crawlability — how the site shows up when it is shared.
import { test, expect } from '@playwright/test';
import { PAGES, CAT_SAMPLE, SUPPLY, seedConsent } from '../helpers/util.mjs';

const SITE = 'https://hypurrterminal.xyz';

test.beforeEach(async ({ context }) => { await seedConsent(context); });

async function meta(page) {
  return page.evaluate(() => {
    const g = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) || null;
    return {
      title: document.title,
      description: g('meta[name="description"]'),
      canonical: g('link[rel="canonical"]', 'href'),
      robots: g('meta[name="robots"]'),
      themeColor: g('meta[name="theme-color"]'),
      viewport: g('meta[name="viewport"]'),
      ogType: g('meta[property="og:type"]'),
      ogTitle: g('meta[property="og:title"]'),
      ogDesc: g('meta[property="og:description"]'),
      ogImage: g('meta[property="og:image"]'),
      ogUrl: g('meta[property="og:url"]'),
      twCard: g('meta[name="twitter:card"]'),
      twImage: g('meta[name="twitter:image"]'),
      twTitle: g('meta[name="twitter:title"]'),
      twDesc: g('meta[name="twitter:description"]'),
    };
  });
}

for (const p of PAGES) {
  test(`seo ${p.name}: metadata is complete`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const m = await meta(page);
    const problems = [];

    if (!m.title || m.title.length > 70) problems.push(`title ${m.title?.length} chars`);
    if (!m.description) problems.push('no meta description');
    else if (m.description.length < 50 || m.description.length > 200) problems.push(`description ${m.description.length} chars`);
    if (!m.viewport) problems.push('no viewport meta');
    if (!m.themeColor) problems.push('no theme-color');
    if (!m.canonical) problems.push('no canonical');
    else {
      const want = p.path === '/' ? SITE : SITE + p.path;
      if (m.canonical.replace(/\/$/, '') !== want.replace(/\/$/, '')) problems.push(`canonical ${m.canonical} should be ${want}`);
    }
    for (const [k, v] of Object.entries({ 'og:title': m.ogTitle, 'og:description': m.ogDesc, 'og:image': m.ogImage, 'og:url': m.ogUrl, 'twitter:card': m.twCard, 'twitter:image': m.twImage })) {
      if (!v) problems.push(`missing ${k}`);
    }
    if (m.ogUrl && m.ogUrl.replace(/\/$/, '') !== (p.path === '/' ? SITE : SITE + p.path)) problems.push(`og:url ${m.ogUrl}`);

    expect(problems, `${p.path} metadata`).toEqual([]);
  });
}

for (const id of CAT_SAMPLE) {
  test(`seo passport /cat/${id}: unfurl metadata`, async ({ page }) => {
    await page.goto(`/cat/${id}`, { waitUntil: 'domcontentloaded' });
    const m = await meta(page);
    const problems = [];
    if (!m.title.includes(`#${id}`)) problems.push(`title does not name the Hypurr: ${m.title}`);
    if (!m.description) problems.push('no description');
    if (!m.canonical) problems.push('no canonical (duplicate-content risk across /cat/N and /cat/N.html)');
    else if (m.canonical !== `${SITE}/cat/${id}`) problems.push(`canonical ${m.canonical}`);
    if (m.ogUrl !== `${SITE}/cat/${id}`) problems.push(`og:url ${m.ogUrl}`);
    if (!m.ogImage?.includes(`/img/${id}.`)) problems.push(`og:image ${m.ogImage}`);
    if (!m.twCard) problems.push('no twitter:card');
    if (!m.twTitle) problems.push('no twitter:title');
    if (!m.twDesc) problems.push('no twitter:description');
    expect(problems, `/cat/${id} unfurl`).toEqual([]);
  });
}

test('seo: og images exist and are the right size', async ({ request, baseURL }) => {
  const og = await request.get(`${baseURL}/og.png`);
  expect(og.status()).toBe(200);
  const buf = await og.body();
  expect(buf.length).toBeGreaterThan(5000);
  // PNG IHDR: width/height at bytes 16..24
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  expect({ width, height }, 'og.png should be 1200×630').toEqual({ width: 1200, height: 630 });

  for (const id of CAT_SAMPLE) {
    const r = await request.get(`${baseURL}/img/${id}.webp`);
    expect(r.status(), `/img/${id}.webp`).toBe(200);
  }
});

test('seo: robots and sitemaps are valid and complete', async ({ request, baseURL }) => {
  const robots = await request.get(`${baseURL}/robots.txt`);
  expect(robots.status()).toBe(200);
  const robotsText = await robots.text();
  expect(robotsText).toContain('Sitemap: https://hypurrterminal.xyz/sitemap.xml');
  expect(robotsText).toContain('Sitemap: https://hypurrterminal.xyz/sitemap-cats.xml');

  const sm = await request.get(`${baseURL}/sitemap.xml`);
  expect(sm.status()).toBe(200);
  const smText = await sm.text();
  const locs = [...smText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThan(3);

  // every listed page must resolve, and every real page must be listed
  const problems = [];
  for (const loc of locs) {
    const res = await request.get(loc.replace(SITE, baseURL));
    if (!res.ok()) problems.push(`${loc} -> HTTP ${res.status()}`);
  }
  for (const p of PAGES) {
    const want = (p.path === '/' ? SITE + '/' : SITE + p.path);
    if (!locs.some((l) => l.replace(/\/$/, '') === want.replace(/\/$/, ''))) problems.push(`${p.path} missing from sitemap`);
  }
  expect(problems).toEqual([]);

  const cats = await request.get(`${baseURL}/sitemap-cats.xml`);
  expect(cats.status()).toBe(200);
  const catText = await cats.text();
  const catLocs = [...catText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(catLocs.length, 'sitemap-cats should list every Hypurr').toBe(SUPPLY);
  const malformed = catLocs.filter((l) => !/^https:\/\/hypurrterminal\.xyz\/cat\/\d+$/.test(l)).slice(0, 3);
  expect(malformed).toEqual([]);
  for (const l of [catLocs[0], catLocs[Math.floor(SUPPLY / 2)], catLocs[SUPPLY - 1]]) {
    const res = await request.get(l.replace(SITE, baseURL));
    expect(res.status(), l).toBe(200);
  }
});

test('seo: retired routes are noindexed and redirect', async ({ request, baseURL }) => {
  for (const path of ['/pulse', '/wallet']) {
    const res = await request.get(baseURL + path);
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    expect(html, `${path} should be noindex`).toContain('name="robots" content="noindex"');
    expect(html).toContain('/positioning');
  }
});

test('seo: the disclaimer that keeps this unofficial is on every page', async ({ page }) => {
  test.slow();
  const missing = [];
  for (const p of PAGES.concat([{ path: '/cat/4203', name: 'passport' }])) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const text = (await page.locator('body').innerText()).toLowerCase();
    if (!text.includes('unofficial')) missing.push(`${p.path}: no "unofficial"`);
    if (!/not (financial )?advice|no pnl|never pnl|not a signal/.test(text)) missing.push(`${p.path}: no not-advice line`);
  }
  expect(missing, 'disclaimer coverage').toEqual([]);
});

test('seo: no PnL language leaks into the rendered pages', async ({ page }) => {
  test.slow();
  const leaks = [];
  for (const p of PAGES.concat([{ path: '/cat/4203' }])) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const found = await page.evaluate(() => {
      const t = document.body.innerText;
      const bad = [];
      // "no PnL"/"never PnL" is the disclaimer, not a leak
      const re = /(unrealized|realized)\s*p&?n?l|account value|liquidation price|entry price|withdrawable/gi;
      let m; while ((m = re.exec(t))) bad.push(m[0]);
      return bad;
    });
    if (found.length) leaks.push(`${p.path}: ${found.slice(0, 3).join(', ')}`);
  }
  expect(leaks, 'PnL/balance language on the page').toEqual([]);
});
