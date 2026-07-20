import fs from "node:fs";
const LAVA="https://hyperliquid.lava.build";
const ZERO="0x0000000000000000000000000000000000000000";
const dist="0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";
const {transfers}=JSON.parse(fs.readFileSync("./data/transfers_raw.json"));
const CACHE="./data/blockts.json";
let cache={}; try{cache=JSON.parse(fs.readFileSync(CACHE));}catch{}
// unique blocks among all trade transfers (sale candidates)
const blocks=[...new Set(transfers.filter(t=>t.from!==ZERO&&t.from!==dist).map(t=>t.block))];
const todo=blocks.filter(b=>!(b in cache));
console.log(`unique trade blocks ${blocks.length}, cached ${blocks.length-todo.length}, todo ${todo.length}`);
async function batch(calls,tries=8){for(let a=0;a<tries;a++){try{const body=calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.method,params:c.params}));const r=await fetch(LAVA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const j=await r.json();if(!Array.isArray(j)){await new Promise(s=>setTimeout(s,300*(a+1)));continue;}const out=new Array(calls.length);let bad=0;for(const it of j){if(it.error)bad++;out[it.id]=it.error?null:it.result;}if(bad>calls.length*0.5){await new Promise(s=>setTimeout(s,300*(a+1)));continue;}return out;}catch{await new Promise(s=>setTimeout(s,300*(a+1)));}}return new Array(calls.length).fill(null);}
const B=25,C=10;const groups=[];for(let i=0;i<todo.length;i+=B)groups.push(todo.slice(i,i+B));
let gi=0,done=0;
async function run(){while(gi<groups.length){const my=gi++;const g=groups[my];const r=await batch(g.map(b=>({method:"eth_getBlockByNumber",params:["0x"+b.toString(16),false]})));g.forEach((b,k)=>{const bl=r[k];if(bl&&bl.timestamp)cache[b]=parseInt(bl.timestamp,16);});done++;if(done%20===0){process.stdout.write(`  ${done*B}/${todo.length}\r`);fs.writeFileSync(CACHE,JSON.stringify(cache));}}}
await Promise.all(Array.from({length:C},run));
fs.writeFileSync(CACHE,JSON.stringify(cache));
console.log(`\ncached ${blocks.filter(b=>b in cache).length}/${blocks.length} block timestamps`);
