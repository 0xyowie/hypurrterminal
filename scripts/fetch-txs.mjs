import fs from "node:fs";
const LAVA="https://hyperliquid.lava.build";
const NFT="0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const ZERO="0x0000000000000000000000000000000000000000";
const dist="0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";
const {transfers}=JSON.parse(fs.readFileSync("./data/transfers_raw.json"));
const CACHE="./data/tx_cache.json";
let cache={}; try{cache=JSON.parse(fs.readFileSync(CACHE));}catch{}
const trades=transfers.filter(t=>t.from!==ZERO && t.from!==dist);
const tradeTx=[...new Set(trades.map(t=>t.tx))];
const todo=tradeTx.filter(h=>!(h in cache));
console.log(`trade txs ${tradeTx.length}, cached ${tradeTx.length-todo.length}, todo ${todo.length}`);
async function batch(calls,tries=8){for(let a=0;a<tries;a++){try{
  const body=calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.method,params:c.params}));
  const r=await fetch(LAVA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const j=await r.json(); if(!Array.isArray(j)){await new Promise(s=>setTimeout(s,300*(a+1)));continue;}
  const out=new Array(calls.length);let bad=0;for(const it of j){if(it.error)bad++;out[it.id]=it.error?null:it.result;}
  if(bad>calls.length*0.5){await new Promise(s=>setTimeout(s,300*(a+1)));continue;} return out;
}catch{await new Promise(s=>setTimeout(s,300*(a+1)));}}return new Array(calls.length).fill(null);}
const B=25,C=10; const groups=[];for(let i=0;i<todo.length;i+=B)groups.push(todo.slice(i,i+B));
let gi=0,done=0;
async function run(){while(gi<groups.length){const my=gi++;const g=groups[my];const r=await batch(g.map(h=>({method:"eth_getTransactionByHash",params:[h]})));
  g.forEach((h,k)=>{const tx=r[k]; if(tx){cache[h]={to:(tx.to||"").toLowerCase(),val:tx.value||"0x0"};}});
  done++; if(done%20===0){process.stdout.write(`  ${done*B}/${todo.length}\r`); fs.writeFileSync(CACHE,JSON.stringify(cache));}}}
await Promise.all(Array.from({length:C},run));
fs.writeFileSync(CACHE,JSON.stringify(cache));
const got=tradeTx.filter(h=>h in cache).length;
console.log(`\ncached ${got}/${tradeTx.length} trade txs`);
