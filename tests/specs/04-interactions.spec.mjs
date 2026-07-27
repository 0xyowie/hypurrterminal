// The controls people actually touch: search, filters, sort, modals, wallet lookup,
// passport share card.
import { test, expect } from '@playwright/test';
import { attachDiagnostics, seedConsent, getJSON } from '../helpers/util.mjs';

test.beforeEach(async ({ context }) => { await seedConsent(context); });

test('Collection: search, sort, live filter and the detail sheet', async ({ page }) => {
  const diag = attachDiagnostics(page);
  await page.goto('/collection');
  const grid = page.locator('#grid .cat');
  await expect.poll(() => grid.count(), { timeout: 25_000 }).toBeGreaterThan(10);

  // search by id narrows the grid
  await page.fill('#q', '4203');
  await expect.poll(() => grid.count(), { timeout: 10_000 }).toBeLessThan(50);
  await expect(page.locator('#grid')).toContainText('4203');

  await page.fill('#q', '');
  await expect.poll(() => grid.count(), { timeout: 10_000 }).toBeGreaterThan(10);

  // "only live" must never show more than everything
  const before = await page.locator('#count').innerText();
  await page.locator('#onlyLive').check({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  const after = await page.locator('#count').innerText();
  expect(parseInt(after.replace(/\D/g, '') || '0', 10)).toBeLessThanOrEqual(parseInt(before.replace(/\D/g, '') || '0', 10));
  await page.locator('#onlyLive').uncheck({ force: true }).catch(() => {});

  // sort changes the order
  const first = () => page.locator('#grid .cat').first().getAttribute('aria-label');
  const a = await first();
  await page.selectOption('#sortSel', { index: 1 }).catch(() => {});
  await page.waitForTimeout(800);
  const b = await first();
  expect(a === b && (await page.locator('#sortSel option').count()) > 1 ? 'sort had no effect' : 'ok').toBe('ok');

  // detail sheet: click, keyboard, escape
  await page.locator('#grid .cat').first().click();
  const modal = page.locator('#modal');
  await expect(modal).toHaveClass(/open/);
  await expect(page.locator('#sheet')).toBeVisible();
  expect(await modal.getAttribute('aria-hidden')).toBe('false');
  // focus moved into the dialog
  const focusInside = await page.evaluate(() => document.getElementById('sheet')?.contains(document.activeElement));
  expect(focusInside, 'focus stays outside the dialog').toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(modal).not.toHaveClass(/open/);

  // keyboard activation of a card (they are divs with role=button)
  await page.locator('#grid .cat').first().focus();
  await page.keyboard.press('Enter');
  await expect(modal).toHaveClass(/open/);
  await page.keyboard.press('Escape');

  expect(diag.pageErrors).toEqual([]);
  expect(diag.consoleErrors).toEqual([]);
});

test('The Desk: rows render, filters and search work', async ({ page }) => {
  const diag = attachDiagnostics(page);
  await page.goto('/desk');
  const rows = page.locator('#rows tr, #rows .row');
  await expect.poll(() => rows.count(), { timeout: 25_000 }).toBeGreaterThan(5);
  const total = await rows.count();

  // coin filter
  const coinOptions = await page.locator('#coin option').count();
  expect(coinOptions, 'coin filter never populated').toBeGreaterThan(3);
  await page.selectOption('#coin', { index: 1 });
  await page.waitForTimeout(700);
  const filtered = await rows.count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThanOrEqual(total);
  await page.selectOption('#coin', '');

  // stance filter
  await page.selectOption('#stance', 'short');
  await page.waitForTimeout(700);
  expect(await rows.count()).toBeLessThanOrEqual(total);
  await page.selectOption('#stance', '');

  // search for a wallet that is definitely on the desk
  await page.waitForTimeout(400);
  const firstText = await rows.first().innerText();
  const idMatch = firstText.match(/#?(\d{1,4})/);
  if (idMatch) {
    await page.fill('#q', idMatch[1]);
    await page.waitForTimeout(700);
    expect(await rows.count()).toBeGreaterThan(0);
  }

  expect(diag.pageErrors).toEqual([]);
  expect(diag.consoleErrors).toEqual([]);
});

test('The Index: wallet lookup handles a real holder and junk input', async ({ page, request, baseURL }) => {
  const diag = attachDiagnostics(page);
  const owners = await getJSON(request, baseURL, 'owners.json');
  const holder = owners[1];

  await page.goto('/positioning');
  await page.locator('#addr').scrollIntoViewIfNeeded();
  await page.fill('#addr', holder);
  await page.click('#go');
  await expect(page.locator('#wsum')).toContainText(/Hypurr|holds|position|flat/i, { timeout: 25_000 });
  await expect.poll(() => page.locator('#wcats img, #wcats .cat').count(), { timeout: 20_000 }).toBeGreaterThan(0);

  // junk input must be rejected with a message, not a thrown error
  await page.fill('#addr', 'not-an-address');
  await page.click('#go');
  await expect(page.locator('#status')).toContainText(/does|wallet address|0x/i, { timeout: 15_000 });

  // a valid address that holds no Hypurr must say so
  await page.fill('#addr', '0x0000000000000000000000000000000000000001');
  await page.click('#go');
  await expect(page.locator('#status')).toContainText(/holds no Hypurrs/i, { timeout: 15_000 });
  await expect(page.locator('#wsum')).toContainText(/0/);

  expect(diag.pageErrors).toEqual([]);
  expect(diag.consoleErrors).toEqual([]);
});

test('The Index: pulse chart and leaderboards render', async ({ page }) => {
  await page.goto('/positioning');
  // The charts are 2D canvases: an empty canvas is a silent failure, so count pixels.
  const painted = (id) => page.evaluate((sel) => {
    const c = document.getElementById(sel);
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, id);
  await expect.poll(() => painted('sentchart'), { timeout: 25_000, message: 'sentiment chart never drew' }).toBeGreaterThan(500);
  await expect.poll(() => painted('scatchart'), { timeout: 25_000, message: 'rarity/price scatter never drew' }).toBeGreaterThan(500);
  await expect(page.locator('#boards')).not.toBeEmpty();
  await expect(page.locator('#coinrows')).not.toBeEmpty();
  await expect(page.locator('#t-live')).not.toHaveText(/^\s*(—|-)?\s*$/);
});

test('The Pride: tiles, filter and detail sheet', async ({ page }) => {
  const diag = attachDiagnostics(page);
  await page.goto('/pride');
  const cards = page.locator('#grid .oc, #grid .cat');
  await expect.poll(() => cards.count(), { timeout: 25_000 }).toBeGreaterThan(5);
  await expect(page.locator('#t-dia')).not.toHaveText(/^\s*(—|-)?\s*$/);
  await expect(page.locator('#tiles')).not.toBeEmpty();

  // search narrows, and the sheet opens
  const before = await cards.count();
  await page.fill('#pq', '4203');
  await expect.poll(() => cards.count(), { timeout: 10_000 }).toBeLessThanOrEqual(before);
  await page.fill('#pq', '');
  await page.waitForTimeout(600);
  await cards.first().click();
  await expect(page.locator('#modal')).toHaveClass(/open/);
  await expect(page.locator('#sheet')).toContainText(/ownership history|Hypurr/i);
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal')).not.toHaveClass(/open/);
  expect(diag.pageErrors).toEqual([]);
  expect(diag.consoleErrors).toEqual([]);
});

test('Passport: card canvas composes and the copy action works', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const diag = attachDiagnostics(page);
  await page.goto('/cat/4203');

  // #pp is the offscreen 1000×1250 share card; it must exist and be composed
  await expect(page.locator('#pp')).toHaveCount(1);
  // sale history for a much-flipped Hypurr must render
  await expect(page.locator('#salebox')).not.toBeEmpty();

  const share = page.locator('#shareBtn');
  await expect(share).toBeVisible();
  await expect(share).toHaveText(/download|share/i);

  // the share card is composed on a canvas: it must contain actual pixels
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('pp');
    const ctx = c && c.getContext('2d');
    if (!ctx) return 'no 2d context';
    const d = ctx.getImageData(0, 0, Math.min(c.width, 300), Math.min(c.height, 300)).data;
    let nonBlank = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBlank++;
    return nonBlank > 1000 ? 'ok' : `blank (${nonBlank} px)`;
  });
  expect(drawn, 'passport share card is blank').toBe('ok');

  await page.click('#copyBtn');
  await expect(page.locator('#copyBtn')).toHaveText(/copied|✓/i, { timeout: 8000 });

  expect(diag.pageErrors).toEqual([]);
  expect(diag.consoleErrors).toEqual([]);
});
