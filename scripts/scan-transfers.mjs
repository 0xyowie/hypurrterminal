import fs from "node:fs";
const LAVA="https://hyperliquid.lava.build";
const NFT="0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const XFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
async function rpc(m,p,tries=10){for(let a=0;a<tries;a++){try{const r=await fetch(LAVA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}),signal:AbortSignal.timeout(25000)});const j=await r.json();if(j.error){await new Promise(s=>setTimeout(s,250*(a+1)));continue;}return j.result;}catch{await new Promise(s=>setTimeout(s,250*(a+1)));}}return null;}
async function pool(items,w,c=8,onp){const out=new Array(items.length);let i=0,d=0;async function run(){while(i<items.length){const my=i++;out[my]=await w(items[my]);d++;if(onp&&d%20===0)onp(d,items.length);}}await Promise.all(Array.from({length:c},run));return out;}
const latest=parseInt(await rpc("eth_blockNumber",[]),16);
const SPAN=100000,ranges=[];for(let f=15060000;f<=latest;f+=SPAN+1)ranges.push([f,Math.min(f+SPAN,latest)]);
console.log("scanning",ranges.length,"ranges to block",latest);
let failed=0;
const chunks=await pool(ranges,async([f,t])=>{const l=await rpc("eth_getLogs",[{address:NFT,topics:[XFER],fromBlock:"0x"+f.toString(16),toBlock:"0x"+t.toString(16)}]);if(l==null){failed++;return[];}return Array.isArray(l)?l:[];},8,(d,n)=>process.stdout.write(`  ${d}/${n} ranges\r`));
const transfers=chunks.flat().map(l=>({
  id:parseInt(l.topics[3],16),
  from:"0x"+l.topics[1].slice(26),
  to:"0x"+l.topics[2].slice(26),
  block:parseInt(l.blockNumber,16),
  tx:l.transactionHash,
  li:parseInt(l.logIndex,16),
})).sort((a,b)=>a.block-b.block||a.li-b.li);
fs.writeFileSync("./data/transfers_raw.json",JSON.stringify({latest,transfers}));
const uniqTx=new Set(transfers.map(t=>t.tx));
console.log(`\ntransfers: ${transfers.length}  unique txs: ${uniqTx.size}  failed ranges: ${failed}`);
// classify
const dist=JSON.parse(fs.readFileSync("./data/provenance_all.json")).distributor?.toLowerCase();
const ZERO="0x0000000000000000000000000000000000000000";
let mint=0,air=0,trade=0;
for(const t of transfers){ if(t.from===ZERO)mint++; else if(dist&&t.from===dist)air++; else trade++; }
console.log(`mints:${mint} airdrops:${air} trades:${trade}  (distributor=${dist})`);
const tradeTx=new Set(transfers.filter(t=>t.from!==ZERO && t.from!==dist).map(t=>t.tx));
console.log(`unique TRADE txs (need tx fetch): ${tradeTx.size}`);
