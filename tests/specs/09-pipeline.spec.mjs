// The refresh pipeline: is the cron actually running, is the data arriving,
// and are the guardrails still in the script?
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJSON, ageMinutes, IS_LIVE } from '../helpers/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = process.env.GH_REPO || '0xyowie/hypurrterminal';

test('workflow file is present and sane', async () => {
  const wf = path.join(ROOT, '.github/workflows/refresh.yml');
  expect(fs.existsSync(wf), 'refresh workflow missing').toBeTruthy();
  const y = fs.readFileSync(wf, 'utf8');
  expect(y).toMatch(/cron:\s*'[^']+'/);
  expect(y, 'workflow needs write permission to commit data').toMatch(/permissions:[\s\S]*contents:\s*write/);
  expect(y, 'runs should not stack on top of each other').toMatch(/concurrency:/);
  expect(y).toContain('refresh-prod.mjs');
  expect(y, 'a rebase before push avoids losing a cycle to a race').toMatch(/git pull --rebase/);
});

test('the refresh script still refuses to publish PnL or a degraded snapshot', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/refresh-prod.mjs'), 'utf8');
  expect(src, 'forbidden-key guard removed').toMatch(/FORBIDDEN\s*=\s*\[/);
  expect(src).toMatch(/FORBIDDEN\.some\([\s\S]*process\.exit\(1\)/);
  expect(src, 'the "refuse a degraded snapshot" guard is gone').toMatch(/refusing to write a degraded snapshot/);
  expect(src, 'history should stay bounded').toMatch(/8800|slice\(hist\.length/);
});

test('published data is fresh relative to the cron cadence', async ({ request, baseURL }) => {
  test.skip(!IS_LIVE, 'freshness is a property of production, not of a checkout');
  const idx = await getJSON(request, baseURL, 'index.json');
  const age = ageMinutes(idx.generatedAt);
  // the cron asks for every 15 minutes; GitHub delays it, so 3 hours is the alarm line
  expect(Math.round(age), `index.json is ${Math.round(age)} minutes old`).toBeLessThan(180);
});

test('history shows a healthy cadence with no long blackouts', async ({ request, baseURL }) => {
  const hist = await getJSON(request, baseURL, 'history.json');
  const pts = hist.points;
  expect(pts.length).toBeGreaterThan(5);

  const gaps = [];
  for (let i = 1; i < pts.length; i++) gaps.push((pts[i].t - pts[i - 1].t) / 60);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = Math.max(...gaps);
  const recent = gaps.slice(-20);
  const recentMax = Math.max(...recent);

  console.log(`refresh cadence — median ${median.toFixed(0)}min, worst ${max.toFixed(0)}min, worst of last 20 ${recentMax.toFixed(0)}min, ${pts.length} points`);
  expect(recentMax, `a ${Math.round(recentMax)} minute blackout in the last 20 cycles`).toBeLessThan(360);
  expect(median, `median gap ${Math.round(median)}min — the cron asks for 15`).toBeLessThan(180);
});

test('recent GitHub Actions runs are succeeding', async ({ request }) => {
  const res = await request.get(`https://api.github.com/repos/${REPO}/actions/workflows/refresh.yml/runs?per_page=20`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  test.skip(res.status() === 403 || res.status() === 401, 'GitHub API rate-limited or private repo');
  expect(res.status()).toBe(200);
  const j = await res.json();
  const runs = (j.workflow_runs || []).filter((r) => r.status === 'completed');
  test.skip(runs.length === 0, 'no completed runs to judge');

  const failures = runs.filter((r) => r.conclusion !== 'success');
  console.log(`last ${runs.length} refresh runs: ${runs.length - failures.length} ok, ${failures.length} failed`);
  const lastRun = runs[0];
  const lastAgeMin = (Date.now() - new Date(lastRun.updated_at).getTime()) / 60000;
  expect(lastAgeMin, `last refresh run finished ${Math.round(lastAgeMin)} minutes ago`).toBeLessThan(240);
  expect(failures.length / runs.length, `failure rate over the last ${runs.length} runs`).toBeLessThan(0.35);
});

test('live data matches what the repo last committed', async ({ request, baseURL }) => {
  test.skip(process.env.TARGET !== 'live', 'deploy-freshness check only makes sense against production');
  const gh = await request.get(`https://api.github.com/repos/${REPO}/contents/site/data/index.json?ref=main`, {
    headers: { accept: 'application/vnd.github.raw' },
  });
  test.skip(!gh.ok(), 'cannot read the repo copy');
  const repoIdx = JSON.parse(await gh.text());
  const liveIdx = await getJSON(request, baseURL, 'index.json');
  const lag = (new Date(repoIdx.generatedAt) - new Date(liveIdx.generatedAt)) / 60000;
  console.log(`repo cycle ${repoIdx.generatedAt}, live cycle ${liveIdx.generatedAt} (${Math.round(lag)}min behind)`);
  expect(lag, 'production is serving data older than the repo — a deploy did not land').toBeLessThan(60);
});
