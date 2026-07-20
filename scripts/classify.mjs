import fs from "node:fs";
const NFT="0x9125e2d6827a00b0f8330d6ef7bef07730bac685";
const ZERO="0x0000000000000000000000000000000000000000";
const dist="0xdc97b8a7023c5e29b1ca17ed9e850b8ba457d610";
const {transfers}=JSON.parse(fs.readFileSync("./data/transfers_raw.json"));
const cache=JSON.parse(fs.readFileSync("./data/tx_cache.json"));
const trades=transfers.filter(t=>t.from!==ZERO && t.from!==dist);
const tradeTx=[...new Set(trades.map(t=>t.tx))];
let native=0,needRc=0,plain=0,noTx=0;
const needReceipt=[];
for(const h of tradeTx){ const tx=cache[h]; if(!tx){noTx++;continue;}
  const val=Number(BigInt(tx.val))/1e18;
  if(val>0.001){native++;continue;}
  if(tx.to===NFT){plain++;continue;}
  needRc++; needReceipt.push(h);
}
console.log(`native-HYPE sale txs: ${native}`);
console.log(`plain-transfer txs (no payment): ${plain}`);
console.log(`need receipt (marketplace/WHYPE): ${needRc}`);
console.log(`missing tx: ${noTx}`);
fs.writeFileSync("./data/need_receipt.json",JSON.stringify(needReceipt));
// what are the top 'to' contracts among sales?
const tos={}; for(const h of tradeTx){const tx=cache[h];if(!tx)continue; const val=Number(BigInt(tx.val))/1e18; if(val>0.001||tx.to!==NFT){tos[tx.to]=(tos[tx.to]||0)+1;}}
console.log("top marketplace/router contracts:");
Object.entries(tos).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([a,n])=>console.log(`  ${a}  ${n}`));
