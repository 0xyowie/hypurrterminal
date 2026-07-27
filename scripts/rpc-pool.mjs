// A small self-healing pool over the public HyperEVM RPC endpoints.
//
// Why this exists: the official endpoint (rpc.hyperliquid.xyz) rate-limits hard and,
// once it does, keeps timing out for minutes. A plain round-robin keeps sending it
// traffic and every request pays the full timeout before rotating, which is how a
// 640-window scan turned into an hours-long crawl. The pool tracks each endpoint's
// health and simply stops picking one that is unwell until its cooldown expires.
//
// Nothing here is Hypurr-specific; it is a transport.

export const HYPEREVM_RPCS = [
  "https://hyperliquid.lava.build",
  "https://rpc.purroofgroup.com",
  "https://hyperliquid.drpc.org",
  "https://hyperliquid-json-rpc.stakely.io",
  "https://rpc.hyperlend.finance",
  "https://rpc.hypurrscan.io",
  "https://rpc.hyperliquid.xyz/evm",
];

const sleep = ms => new Promise(s => setTimeout(s, ms));

export function makePool(urls = HYPEREVM_RPCS, { timeout = 15000 } = {}) {
  const eps = urls.map(u => ({ u, next: 0, streak: 0, ok: 0, bad: 0 }));

  // Cooldown grows with the consecutive-failure streak and is forgiven on the first
  // success, so a briefly flaky endpoint comes back into rotation quickly and a dead
  // one is effectively parked.
  function penalise(e, ms) { e.streak++; e.bad++; e.next = Date.now() + Math.min(120000, ms * Math.pow(2, e.streak - 1)); }
  function reward(e) { e.streak = 0; e.ok++; e.next = 0; }

  async function pick() {
    let best = eps[0];
    for (const e of eps) if (e.next < best.next) best = e;
    const wait = best.next - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 5000));
    return best;
  }

  // nullOk=false is the important default. A node that has pruned an old transaction
  // answers eth_getTransactionReceipt with a successful `null` rather than an error.
  // Accepting that as an answer is how 855 real sales quietly vanished from the
  // backfill: the receipt looked empty, so the sale looked unpriced. Treat a null
  // result as "this endpoint does not have it" and ask a different one.
  async function call(method, params, { tries = 8, nullOk = false } = {}) {
    let lastErr = "no attempt";
    for (let a = 0; a < tries; a++) {
      const e = await pick();
      try {
        const r = await fetch(e.u, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeout),
        });
        if (r.status === 429) { penalise(e, 4000); lastErr = "429"; continue; }
        const j = await r.json();
        if (j.error) {
          const msg = String(j.error.message || "");
          lastErr = msg || "rpc error";
          // Rate limiting is the endpoint's problem; a malformed request is ours and
          // retrying elsewhere will not help.
          if (/rate limit|too many|capacity|busy/i.test(msg)) { penalise(e, 3000); continue; }
          reward(e);
          throw new Error(msg);
        }
        if (!nullOk && (j.result === null || j.result === undefined)) {
          penalise(e, 1000); lastErr = `${method} -> null (endpoint has no record)`; continue;
        }
        reward(e);
        return j.result;
      } catch (err) {
        if (err && err.__rpcFatal) throw err;
        lastErr = err && err.message || String(err);
        penalise(e, /abort|timeout/i.test(lastErr) ? 8000 : 2000);
      }
    }
    const e = new Error(`${method} failed after ${tries} tries: ${lastErr}`);
    e.rpc = true;
    throw e;
  }

  // Best-effort variant: returns null instead of throwing.
  async function soft(method, params, opts) {
    try { return await call(method, params, opts); } catch { return null; }
  }

  function health() {
    return eps.map(e => `${e.u.replace(/^https:\/\//, "")} ok:${e.ok} bad:${e.bad}`).join(" | ");
  }

  return { call, soft, health, eps };
}

// Bounded-concurrency map with a progress line. Kept here so every script that talks
// to the pool paces itself the same way.
export async function pmap(items, fn, c = 6, label = "") {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function run() {
    while (i < items.length) {
      const my = i++;
      out[my] = await fn(items[my], my);
      done++;
      if (label && (done % 25 === 0 || done === items.length)) {
        process.stdout.write(`${label} ${done}/${items.length}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(c, items.length || 1) }, run));
  if (label && items.length) process.stdout.write(`${label} ${items.length}/${items.length}\n`);
  return out;
}
