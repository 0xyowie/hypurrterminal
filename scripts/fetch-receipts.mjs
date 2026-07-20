import fs from "node:fs";
const LAVA="https://hyperliquid.lava.build";
const NFT="0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const XFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WHYPE="0x5555555555555555555555555555555555555555";
const need=JSON.parse(fs.readFileSync("./data/need_receipt.json"));
const CACHE="./data/rc_cache.json";
let cache={}; try{cache=JSON.parse(fs.readFileSync(CACHE));}catch{}
const todo=need.filter(h=>!(h in cache));
console.log(`need ${need.length}, cached ${need.length-todo.length}, todo ${todo.length}`);
async function batch(calls,tries=8){for(let a=0;a<tries;a++){try{
  const body=calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.method,params:c.params}));
  const r=await fetch(LAVA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const j=await r.json(); if(!Array.isArray(j)){await new Promise(s=>setTimeout(s,300*(a+1)));continue;}
  const out=new Array(calls.length);let bad=0;for(const it of j){if(it.error)bad++;out[it.id]=it.error?null:it.result;}
  if(bad>calls.length*0.5){await new Promise(s=>setTimeout(s,300*(a+1)));continue;} return out;
}catch{await new Promise(s=>setTimeout(s,300*(a+1)));}}return new Array(calls.length).fill(null);}
// store: {w:[whype amounts], o:[[token,amt]]} minimal
const B=12,C=10; const groups=[];for(let i=0;i<todo.length;i+=B)groups.push(todo.slice(i,i+B));
let gi=0,done=0;
async function run(){while(gi<groups.length){const my=gi++;const g=groups[my];
  const r=await batch(g.map(h=>({method:"eth_getTransactionReceipt",params:[h]})));
  g.forEach((h,k)=>{const rc=r[k]; if(rc&&rc.logs){ let w=[],o=[];
    for(const e of rc.logs){ if(e.topics[0]===XFER&&e.topics.length===3&&e.address.toLowerCase()!==NFT){
      const amt=Number(BigInt(e.data))/1e18; const ad=e.address.toLowerCase();
      if(ad===WHYPE)w.push(amt); else o.push([ad.slice(0,10),Math.round(amt*100)/100]); } }
    cache[h]={w,o}; }});
  done++; if(done%20===0){process.stdout.write(`  ${done*B}/${todo.length}\r`); fs.writeFileSync(CACHE,JSON.stringify(cache));}}}
await Promise.all(Array.from({length:C},run));
fs.writeFileSync(CACHE,JSON.stringify(cache));
const got=need.filter(h=>h in cache).length;
console.log(`\ncached ${got}/${need.length} receipts`);
