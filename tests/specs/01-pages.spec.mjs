// Every route loads, renders its live data, and does it without errors.
import { test, expect } from '@playwright/test';
import { PAGES, CAT_SAMPLE, attachDiagnostics, seedConsent } from '../helpers/util.mjs';

test.beforeEach(async ({ context }) => { await seedConsent(context); });

for (const p of PAGES) {
  test(`${p.name} (${p.path}) loads clean`, async ({ page }) => {
    const diag = attachDiagnostics(page);
    const res = await page.goto(p.path, { waitUntil: 'domcontentloaded' });

    expect(res?.status(), `${p.path} HTTP status`).toBe(200);
    await expect(page).toHaveTitle(/Hypurr/i);
    expect(await page.locator('body').getAttribute('data-page')).toBe(p.page);

    if (p.ready) {
      const el = page.locator(p.ready);
      await expect(el).toBeVisible();
      // The placeholder is a dash/ellipsis; real data replaces it.
      await expect
        .poll(async () => (await el.innerText()).trim(), { timeout: 25_000, message: `${p.ready} never filled with data` })
        .not.toMatch(/^(—|-|…|\.\.\.|)$/);
    }

    // Nothing broken in the console or the network.
    expect(diag.pageErrors, `uncaught JS errors on ${p.path}`).toEqual([]);
    expect(diag.failedRequests, `failed requests on ${p.path}`).toEqual([]);
    expect(diag.consoleErrors, `console errors on ${p.path}`).toEqual([]);
  });
}

for (const id of CAT_SAMPLE) {
  test(`passport /cat/${id} loads and renders`, async ({ page }) => {
    const diag = attachDiagnostics(page);
    const res = await page.goto(`/cat/${id}`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(`Hypurr #${id}\\b`));

    const embedded = await page.evaluate(() => window.CAT || null);
    expect(embedded, 'window.CAT payload').toBeTruthy();
    expect(embedded.id).toBe(id);
    expect(embedded.owner).toMatch(/^0x[0-9a-f]{40}$/);
    expect(Object.keys(embedded.traits || {}).length).toBeGreaterThan(0);

    // The art must actually load, not 404 into a broken image.
    const art = page.locator(`img[src*="/img/${id}."], img[src*="/img/${id}.webp"]`).first();
    await expect(art).toBeVisible();
    expect(await art.evaluate((n) => n.naturalWidth)).toBeGreaterThan(0);

    expect(diag.pageErrors).toEqual([]);
    expect(diag.failedRequests).toEqual([]);
    expect(diag.consoleErrors).toEqual([]);
  });
}

test('retired routes redirect into The Index', async ({ page }) => {
  await page.goto('/pulse');
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/positioning');
  expect(page.url()).toContain('#pulse');

  await page.goto('/wallet');
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/positioning');
  expect(page.url()).toContain('#wallet');
});

test('unknown URL serves the 404 page', async ({ page }) => {
  const res = await page.goto('/definitely-not-a-page-xyz');
  expect(res?.status()).toBe(404);
  await expect(page.locator('body')).toContainText(/404|not found|lost/i);
});

test('every internal link on every page resolves', async ({ page, request, baseURL }) => {
  test.slow();
  const seen = new Map();
  for (const p of PAGES.concat([{ path: '/cat/4203' }])) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) {
      if (!h || h.startsWith('#') || h.startsWith('http') || h.startsWith('mailto:')) continue;
      const url = h.split('#')[0];
      if (!url || seen.has(url)) continue;
      const res = await request.get(new URL(url, baseURL).toString());
      seen.set(url, res.status());
    }
  }
  const broken = [...seen].filter(([, s]) => s >= 400);
  expect(broken, `broken internal links: ${JSON.stringify(broken)}`).toEqual([]);
});

test('nav marks the current section and reaches every other one', async ({ page }) => {
  for (const p of PAGES.filter((x) => x.page !== 'landing' && x.page !== 'privacy')) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const active = page.locator(`nav.top a[data-nav="${p.page}"].active`);
    await expect(active, `active nav item on ${p.path}`).toHaveCount(1);
    // retired sections must not linger in the nav
    await expect(page.locator('nav.top a[data-nav="pulse"], nav.top a[data-nav="observatory"]')).toHaveCount(0);
  }
});

test('cookie consent gates Google Analytics', async ({ browser, baseURL }) => {
  // Fresh context: no prior decision -> banner shows, GA must not load.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const gaHits = [];
  page.on('request', (r) => { if (/googletagmanager|google-analytics/.test(r.url())) gaHits.push(r.url()); });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const banner = page.locator('#cookie');
  await expect(banner).toBeVisible();
  await page.waitForTimeout(2500);
  expect(gaHits, 'GA loaded before consent').toEqual([]);

  await page.click('#cc-no');
  await expect(banner).not.toHaveClass(/show/);
  await page.waitForTimeout(1500);
  expect(gaHits, 'GA loaded after declining').toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('hypurr_cookie_consent'))).toBe('declined');

  // Accepting is what turns it on.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  const gaHits2 = [];
  page2.on('request', (r) => { if (/googletagmanager|google-analytics/.test(r.url())) gaHits2.push(r.url()); });
  await page2.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page2.click('#cc-yes');
  await expect.poll(() => gaHits2.length, { timeout: 15_000, message: 'GA never loaded after accepting' }).toBeGreaterThan(0);

  await ctx.close(); await ctx2.close();
});
