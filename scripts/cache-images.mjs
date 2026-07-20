import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { IPFS_GATEWAYS } from "./lib.mjs";
const OUT="./img"; fs.mkdirSync(OUT,{recursive:true});
const traits=JSON.parse(fs.readFileSync("./data/traits.json"));
const toks=traits.tokens.filter(t=>t.image);
const todo=toks.filter(t=>!fs.existsSync(path.join(OUT, t.id+".webp")));
console.log(`total ${toks.length}, cached ${toks.length-todo.length}, todo ${todo.length}`);
async function fetchImg(uri){
  const p=uri.replace(/^ipfs:\/\//,"");
  for(let a=0;a<IPFS_GATEWAYS.length*3;a++){
    const gw=IPFS_GATEWAYS[a%IPFS_GATEWAYS.length];
    try{const r=await fetch(gw+p,{signal:AbortSignal.timeout(20000)}); if(r.ok) return Buffer.from(await r.arrayBuffer());}catch{}
  }
  return null;
}
async function pool(items,w,c,onp){let i=0,done=0,ok=0,fail=0;async function run(){while(i<items.length){const my=i++;const r=await w(items[my]);if(r)ok++;else fail++;done++;if(done%50===0)onp(done,items.length,ok,fail);}}await Promise.all(Array.from({length:c},run));return{ok,fail};}
const res=await pool(todo, async (t)=>{
  const buf=await fetchImg(t.image); if(!buf) return false;
  try{ await sharp(buf).resize(400,400,{fit:"cover"}).webp({quality:72}).toFile(path.join(OUT,t.id+".webp")); return true; }catch{ return false; }
}, 16, (d,n,ok,fail)=>process.stdout.write(`  ${d}/${n}  ok ${ok} fail ${fail}\r`));
const have=toks.filter(t=>fs.existsSync(path.join(OUT,t.id+".webp"))).length;
let bytes=0; for(const t of toks){const f=path.join(OUT,t.id+".webp"); if(fs.existsSync(f)) bytes+=fs.statSync(f).size;}
console.log(`\nthis pass: ok ${res.ok} fail ${res.fail} | total cached ${have}/${toks.length} | ~${(bytes/1024/1024).toFixed(1)}MB`);
