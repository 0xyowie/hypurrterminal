// Shared data-layer helpers for Hypurr Terminal. Portable: no hardcoded paths.
import { ethers } from "ethers";

export const RPC = "https://rpc.hyperliquid.xyz/evm";
export const INFO = "https://api.hyperliquid.xyz/info";
export const NFT = "0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
export const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const SUPPLY = 4600;
export const CHAIN_ID = 999;
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://w3s.link/ipfs/",
];

export const provider = new ethers.JsonRpcProvider(RPC);
export const nftIface = new ethers.Interface([
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
]);
export const mc3 = new ethers.Contract(
  MC3,
  ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"],
  provider
);

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function decodeResult(r, iface, fn) {
  const ok = r.success ?? r[0];
  const rd = r.returnData ?? r[1];
  if (!ok || !rd || rd === "0x") return null;
  try { return iface.decodeFunctionResult(fn, rd)[0]; } catch { return null; }
}

export async function multicallOwnerOf(ids) {
  const calls = ids.map((i) => [NFT, true, nftIface.encodeFunctionData("ownerOf", [i])]);
  const res = await mc3.aggregate3(calls);
  return res.map((r) => { const a = decodeResult(r, nftIface, "ownerOf"); return a ? a.toLowerCase() : null; });
}

export async function multicallTokenURI(ids) {
  const calls = ids.map((i) => [NFT, true, nftIface.encodeFunctionData("tokenURI", [i])]);
  const res = await mc3.aggregate3(calls);
  return res.map((r) => decodeResult(r, nftIface, "tokenURI"));
}

// Fetch ipfs://<cid>[/<path>] JSON with gateway rotation + retry.
export async function fetchIpfsJson(uri, tries = 8) {
  const p = uri.replace(/^ipfs:\/\//, "");
  for (let attempt = 0; attempt < tries; attempt++) {
    const gw = IPFS_GATEWAYS[attempt % IPFS_GATEWAYS.length];
    try {
      const r = await fetch(gw + p, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
    } catch { /* try next gateway */ }
  }
  return null;
}

// Bounded-concurrency map with progress.
export async function pool(items, worker, concurrency = 30, onProgress) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function run() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await worker(items[my], my);
      done++;
      if (onProgress && done % 200 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}
