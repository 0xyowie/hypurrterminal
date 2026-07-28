// Shared constants + helpers for the Hypurr Terminal test suite.
export const SUPPLY = 4600;

// Data age is a property of production, not of a checkout. A commit made during a
// quiet stretch would otherwise fail its own CI for being "stale", which says nothing
// about the code being pushed.
export const IS_LIVE = (process.env.TARGET || 'local') === 'live';

// Every page the site actually serves, with the selector that only fills in
// once that page's live data has arrived.
export const PAGES = [
  { path: '/',            page: 'landing',     ready: '#leanpct',   name: 'Landing' },
  { path: '/collection',  page: 'collection',  ready: '#s-supply',  name: 'The Collection' },
  { path: '/positioning', page: 'positioning', ready: '#t-holders', name: 'The Index' },
  { path: '/desk',        page: 'desk',        ready: '#count',     name: 'The Desk' },
  { path: '/pride',       page: 'pride',       ready: '#t-dia',     name: 'The Pride' },
  { path: '/privacy',     page: 'privacy',     ready: null,         name: 'Privacy' },
];

// Sample of passport pages: first, last, most-flipped, a diamond, a mid id.
export const CAT_SAMPLE = [1, 8, 2300, 4203, 4600];

export const DATA_FILES = [
  'index.json', 'positions.json', 'desk.json', 'cat_states.json', 'owners.json',
  'tokens.json', 'rarity.json', 'sales.json', 'provenance.json', 'og.json',
  'flips.json', 'scatter.json', 'history.json', 'hype_price.json', 'leaders.json',
  'globe.json',
];

// Keys that must never appear anywhere in shipped data or rendered DOM.
export const FORBIDDEN_PNL = [
  'unrealizedPnl', 'returnOnEquity', 'entryPx', 'liquidationPx',
  'accountValue', 'withdrawable', 'marginUsed', 'realizedPnl',
];

// Third-party origins whose failures are not the site's fault.
export const THIRD_PARTY = [
  'googletagmanager.com', 'google-analytics.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
];

export const isThirdParty = (url) => THIRD_PARTY.some((d) => url.includes(d));

// Console noise we deliberately tolerate (extension chatter, favicon probing).
const IGNORE_CONSOLE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[GSI_LOGGER\]/,
];

export function attachDiagnostics(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (IGNORE_CONSOLE.some((re) => re.test(text))) return;
    // Resource errors are reported by the requestfailed/response handlers below with
    // the URL attached; here we only know the location, so use it to drop
    // third-party noise (fonts, analytics) that the site cannot control.
    const from = m.location()?.url || '';
    if (from && isThirdParty(from)) return;
    if (/Failed to load resource/i.test(text) && (!from || isThirdParty(from))) return;
    consoleErrors.push(from ? `${text} (${from})` : text);
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => {
    if (isThirdParty(r.url())) return;
    failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !isThirdParty(r.url())) failedRequests.push(`${r.url()} — HTTP ${r.status()}`);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

// Pages show a consent banner on first visit; seed a decision so it never
// covers the UI or loads GA during tests.
export async function seedConsent(context, value = 'declined') {
  await context.addInitScript((v) => {
    try { localStorage.setItem('hypurr_cookie_consent', v); } catch {}
  }, value);
}

export async function getJSON(request, baseURL, file) {
  const res = await request.get(`${baseURL}/data/${file}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok()) throw new Error(`${file} -> HTTP ${res.status()}`);
  return res.json();
}

export const ageMinutes = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a);

export const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Hyperliquid public info API — used to prove the shipped numbers are real.
export async function hlInfo(request, body) {
  const res = await request.post('https://api.hyperliquid.xyz/info', {
    headers: { 'Content-Type': 'application/json' },
    data: body,
    timeout: 30000,
  });
  if (!res.ok()) throw new Error(`HL info ${body.type} -> HTTP ${res.status()}`);
  return res.json();
}
