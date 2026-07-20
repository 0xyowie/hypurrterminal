import fs from "node:fs";
const LAVA="https://hyperliquid.lava.build";
const NFT="0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const ZERO="0x0000000000000000000000000000000000000000";
const dist="0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";
const {latest,transfers}=JSON.parse(fs.readFileSync("./data/transfers_raw.json"));
const txc=JSON.parse(fs.readFileSync("./data/tx_cache.json"));
const rcc=JSON.parse(fs.readFileSync("./data/rc_cache.json"));
async function batch(calls,tries=8){for(let a=0;a<tries;a++){try{const body=calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.method,params:c.params}));const r=await fetch(LAVA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const j=await r.json();if(!Array.isArray(j)){await new Promise(s=>setTimeout(s,300*(a+1)));continue;}const out=new Array(calls.length);for(const it of j)out[it.id]=it.error?null:it.result;return out;}catch{await new Promise(s=>setTimeout(s,300*(a+1)));}}return new Array(calls.length).fill(null);}
// anchors
const ns=Array.from({length:41},(_,i)=>Math.round(15060000+(latest-15060000)*i/40));
let anchors=[]; for(let i=0;i<ns.length;i+=10){const g=ns.slice(i,i+10);const r=await batch(g.map(n=>({method:"eth_getBlockByNumber",params:["0x"+n.toString(16),false]})));r.forEach(b=>{if(b&&b.timestamp)anchors.push([parseInt(b.number,16),parseInt(b.timestamp,16)]);});}
anchors.sort((a,b)=>a[0]-b[0]);
const blockts=JSON.parse(fs.readFileSync("./data/blockts.json"));
const interp=bk=>{if(bk<=anchors[0][0])return anchors[0][1];for(let i=1;i<anchors.length;i++)if(bk<=anchors[i][0]){const[b0,t0]=anchors[i-1],[b1,t1]=anchors[i];return Math.round(t0+(t1-t0)*(bk-b0)/(b1-b0));}return anchors[anchors.length-1][1];};
const blockToTs=bk=> (blockts[bk]!=null ? blockts[bk] : interp(bk));

const trades=transfers.filter(t=>t.from!==ZERO && t.from!==dist);
const byTx={}; for(const t of trades)(byTx[t.tx]||=[]).push(t);
function paymentFor(h){
  const tx=txc[h]; if(!tx)return null;
  const val=Number(BigInt(tx.val))/1e18;
  if(val>0.001)return {price:val,cur:"HYPE"};
  if(tx.to===NFT)return null;
  const rc=rcc[h]; if(!rc)return {price:null,cur:"UNK"};
  if(rc.w&&rc.w.length)return {price:Math.max(...rc.w),cur:"WHYPE"};
  if(rc.o&&rc.o.length)return {price:null,cur:"OTHER"};
  return null;
}
const byToken={}; let totalHype=0; const priced=[]; let bulk=0,other=0,unk=0,plain=0,dust=0;
const DUST=1; // HYPE floor — below this is a fee-leg / OTC nominal, not a real market sale
for(const h of Object.keys(byTx)){
  const items=byTx[h]; const pay=paymentFor(h);
  if(!pay){plain+=items.length;continue;}
  if(pay.cur==="OTHER"){other+=items.length;continue;}
  if(pay.cur==="UNK"||pay.price==null){unk+=items.length;continue;}
  const per=pay.price/items.length;
  if(per<DUST){dust+=items.length;continue;}
  if(items.length>1)bulk++;
  for(const it of items){
    (byToken[it.id]||=[]).push({ts:blockToTs(it.block),price:Math.round(per*100)/100});
    totalHype+=per; priced.push({id:it.id,hype:per,ts:blockToTs(it.block)});
  }
}
for(const id in byToken)byToken[id].sort((a,b)=>a.ts-b.ts);
priced.sort((a,b)=>a.hype-b.hype);
const recent=priced.slice().sort((a,b)=>b.ts-a.ts);
const stats={
  totalSales:priced.length,totalVolumeHype:Math.round(totalHype),
  avgPriceHype:Math.round(totalHype/Math.max(1,priced.length)),
  minPriceHype:priced.length?Math.round(priced[0].hype):null,
  maxPriceHype:priced.length?Math.round(priced[priced.length-1].hype):null,
  maxSale:priced.length?{id:priced[priced.length-1].id,hype:Math.round(priced[priced.length-1].hype)}:null,
  lastSaleTs:recent[0]?.ts||null, tokensWithSale:Object.keys(byToken).length,
  currencyNote:"HYPE + WHYPE, reconstructed from on-chain payments across all marketplaces",
};
fs.writeFileSync("./data/sales.json",JSON.stringify({generatedAt:new Date().toISOString(),stats,byToken}));
console.log("=== sales.json rebuilt ===");
console.log(JSON.stringify(stats,null,1));
console.log(`bulk txs:${bulk} other-cur:${other} unknown:${unk} dust(<1):${dust} plain-transfers:${plain}`);
console.log("4046:",JSON.stringify(byToken[4046]));
console.log("4203 count:",(byToken[4203]||[]).length,"| 829:",JSON.stringify(byToken[829]));
