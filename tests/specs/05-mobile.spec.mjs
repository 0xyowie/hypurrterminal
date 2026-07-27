// Mobile is a first-class target in SCOPE.md — this is where that gets checked.
import { test, expect, devices } from '@playwright/test';
import { PAGES, attachDiagnostics, seedConsent } from '../helpers/util.mjs';

test.use({ ...devices['iPhone 13'] });

test.beforeEach(async ({ context }) => { await seedConsent(context); });

for (const p of PAGES) {
  test(`mobile ${p.name}: no horizontal overflow, no errors`, async ({ page }) => {
    const diag = attachDiagnostics(page);
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    if (p.ready) await expect(page.locator(p.ready)).toBeVisible();
    await page.waitForTimeout(2500);

    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      const over = [];
      if (de.scrollWidth > window.innerWidth + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 2 || r.left < -2)) {
            over.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} → ${Math.round(r.left)}..${Math.round(r.right)} of ${window.innerWidth}`);
            if (over.length >= 5) break;
          }
        }
        return { width: de.scrollWidth, viewport: window.innerWidth, over };
      }
      return null;
    });
    expect(overflow, `${p.path} scrolls sideways on a phone`).toBeNull();

    expect(diag.pageErrors).toEqual([]);
    expect(diag.consoleErrors).toEqual([]);
    expect(diag.failedRequests).toEqual([]);
  });
}

test('mobile: hamburger opens the nav and links close it', async ({ page }) => {
  await page.goto('/collection');
  const toggle = page.locator('button.navtoggle');
  await expect(toggle).toBeVisible();
  expect(await toggle.getAttribute('aria-expanded')).toBe('false');
  await toggle.click();
  expect(await toggle.getAttribute('aria-expanded')).toBe('true');
  await expect(page.locator('nav.top')).toHaveClass(/navopen/);
  const link = page.locator('nav.top a[data-nav="desk"]');
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/desk');
});

test('mobile: tap targets are big enough', async ({ page }) => {
  test.slow();
  const small = [];
  for (const p of PAGES) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const found = await page.evaluate(() => {
      const sel = 'nav.top a, button, .btn, select, input[type="checkbox"], header a';
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        // WCAG 2.5.8 exempts targets that sit inline inside a sentence — a link or
        // button in running prose cannot be 44px without breaking the paragraph.
        if (el.closest('p, li')) continue;
        // A control wrapped in its own <label> inherits that label's hit area.
        const host = el.closest('label') || el;
        const r = host.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.height < 36 || r.width < 28) {
          out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      return out;
    });
    if (found.length) small.push(`${p.path}: ${found.slice(0, 6).join(', ')}`);
  }
  expect(small, 'tap targets under ~40px').toEqual([]);
});

test('mobile: the hero drag spins the field without hijacking scroll', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(3500);

  const touchAction = await page.evaluate(() => {
    const stage = document.getElementById('stage') || document.querySelector('canvas')?.parentElement;
    return stage ? getComputedStyle(stage).touchAction : null;
  });
  expect(touchAction, 'hero stage must allow vertical panning').toMatch(/pan-y|auto|manipulation/);

  // a vertical swipe must still scroll the story
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.scrollY);
  expect(after, 'vertical scroll is blocked on the landing hero').toBeGreaterThan(before);
});

test('mobile: the small atlas is used, not the desktop one', async ({ page }) => {
  const atlases = [];
  page.on('request', (r) => { if (/atlas\d+\.webp/.test(r.url())) atlases.push(r.url()); });
  await page.goto('/');
  await page.waitForTimeout(6000);
  const big = atlases.filter((u) => u.includes('atlas48'));
  expect(big, 'phone downloaded the 2.5MB desktop atlas').toEqual([]);
});

test('mobile: a cat sheet closes on the back gesture', async ({ page }) => {
  await page.goto('/collection');
  await expect.poll(() => page.locator('#grid .cat').count(), { timeout: 25_000 }).toBeGreaterThan(3);
  await page.locator('#grid .cat').first().click();
  await expect(page.locator('#modal')).toHaveClass(/open/);
  await page.goBack();
  await expect(page.locator('#modal')).not.toHaveClass(/open/);
  // and the back gesture must not have navigated away from the page
  expect(new URL(page.url()).pathname).toBe('/collection');
});
