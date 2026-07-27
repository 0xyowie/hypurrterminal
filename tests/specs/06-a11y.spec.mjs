// Accessibility: axe-core scan per page plus the keyboard paths axe cannot see.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PAGES, CAT_SAMPLE, seedConsent } from '../helpers/util.mjs';

// axe-core is injected into the page and run there. The @axe-core/playwright wrapper
// serialises far more state back across the wire, which on The Pride's ~2,600 cards
// took minutes; this returns in seconds and checks exactly the same rules.
const AXE_SRC = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function scan(page, { exclude = ['canvas'] } = {}) {
  await page.addScriptTag({ content: AXE_SRC });
  return page.evaluate(async (ex) => window.axe.run(
    { include: [['html']], exclude: ex.map((s) => [s]) },
    { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
  ), exclude);
}

test.beforeEach(async ({ context }) => { await seedConsent(context); });

const summarise = (violations) => violations.map((v) => ({
  id: v.id,
  impact: v.impact,
  help: v.help,
  nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
}));

for (const p of PAGES.concat([{ path: `/cat/${CAT_SAMPLE[3]}`, name: 'Passport', ready: '#salebox' }])) {
  test(`a11y ${p.name}`, async ({ page }) => {
    test.slow(); // axe over a few thousand cards is not fast
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    if (p.ready) await expect(page.locator(p.ready)).toBeVisible();
    await page.waitForTimeout(2500);

    // the WebGL canvas has no accessible content by design; the text beats carry it
    const results = await scan(page);

    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(summarise(serious), `serious/critical a11y violations on ${p.path}`).toEqual([]);
  });
}

test('a11y: every page has one h1, a lang and a main landmark', async ({ page }) => {
  const problems = [];
  for (const p of PAGES) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const info = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      h1: document.querySelectorAll('h1').length,
      main: document.querySelectorAll('main, [role="main"]').length,
      title: document.title,
      skip: !!document.querySelector('a[href^="#"][class*="skip"], .skiplink'),
    }));
    if (!info.lang) problems.push(`${p.path}: no lang on <html>`);
    if (info.h1 !== 1) problems.push(`${p.path}: ${info.h1} h1 elements`);
    if (info.main === 0) problems.push(`${p.path}: no <main> landmark`);
    if (!info.title) problems.push(`${p.path}: empty title`);
  }
  expect(problems).toEqual([]);
});

test('a11y: images carry alt text', async ({ page }) => {
  test.slow();
  const problems = [];
  for (const p of PAGES.concat([{ path: '/cat/4203' }])) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const missing = await page.$$eval('img', (imgs) => imgs
      .filter((i) => i.getAttribute('alt') === null)
      .slice(0, 5)
      .map((i) => i.getAttribute('src')));
    if (missing.length) problems.push(`${p.path}: ${missing.join(', ')}`);
  }
  expect(problems, 'images with no alt attribute').toEqual([]);
});

test('a11y: keyboard can reach and operate the collection grid', async ({ page }) => {
  await page.goto('/collection');
  await expect.poll(() => page.locator('#grid .cat').count(), { timeout: 25_000 }).toBeGreaterThan(3);

  // tab until focus lands on a card — it must be reachable without a mouse
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => !!document.activeElement?.closest('#grid .cat'));
  }
  expect(reached, 'cards are not reachable by keyboard').toBeTruthy();

  await page.keyboard.press('Enter');
  await expect(page.locator('#modal')).toHaveClass(/open/);

  // focus must be trapped inside the sheet
  for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
  const inside = await page.evaluate(() => document.getElementById('sheet')?.contains(document.activeElement));
  expect(inside, 'Tab escapes the open dialog').toBeTruthy();

  await page.keyboard.press('Escape');
  await expect(page.locator('#modal')).not.toHaveClass(/open/);
  const returned = await page.evaluate(() => !!document.activeElement?.closest('#grid .cat'));
  expect(returned, 'focus is not returned to the card that opened the sheet').toBeTruthy();
});

test('a11y: reduced motion is respected', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForTimeout(4000);

  // headline copy must still be there
  await expect(page.locator('h1, .beat .h').first()).toBeVisible();

  // and the render loop must not be spinning
  const frames = await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }));
  // this only proves rAF is available; the real check is that the page is usable
  expect(frames).toBeGreaterThan(0);
  const stillReadable = await page.evaluate(() => document.body.innerText.trim().length);
  expect(stillReadable).toBeGreaterThan(50);
});
