// PCA on one-hot trait vectors -> 3D coords for the Observatory (visual-family neighborhoods)
import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const toks = JSON.parse(fs.readFileSync(path.join(ROOT,"data/traits.json"))).tokens;
// dims
const dims=[]; const dimIx={};
for(const t of toks) for(const [k,v] of Object.entries(t.traits)){ const key=k+"::"+v; if(!(key in dimIx)){ dimIx[key]=dims.length; dims.push(key); } }
const N=toks.length, D=dims.length;
console.log(`tokens ${N} · one-hot dims ${D}`);
// build sparse rows + column means
const rows=toks.map(t=>Object.entries(t.traits).map(([k,v])=>dimIx[k+"::"+v]));
const mean=new Float64Array(D);
for(const r of rows) for(const j of r) mean[j]+=1;
for(let j=0;j<D;j++) mean[j]/=N;
// X v (centered) and X^T u without materializing X
function Xv(v){ const out=new Float64Array(N); let mv=0; for(let j=0;j<D;j++) mv+=mean[j]*v[j];
  for(let i=0;i<N;i++){ let s=-mv; for(const j of rows[i]) s+=v[j]; out[i]=s; } return out; }
function XTu(u){ const out=new Float64Array(D); let su=0; for(let i=0;i<N;i++) su+=u[i];
  for(let i=0;i<N;i++) for(const j of rows[i]) out[j]+=u[i];
  for(let j=0;j<D;j++) out[j]-=mean[j]*su; return out; }
const comps=[];
for(let c=0;c<3;c++){
  let v=new Float64Array(D); for(let j=0;j<D;j++) v[j]=Math.random()-0.5;
  for(let it=0; it<60; it++){
    // deflate
    for(const pc of comps){ let d=0; for(let j=0;j<D;j++) d+=v[j]*pc[j]; for(let j=0;j<D;j++) v[j]-=d*pc[j]; }
    const u=Xv(v); const w=XTu(u);
    let n=0; for(let j=0;j<D;j++) n+=w[j]*w[j]; n=Math.sqrt(n)||1;
    for(let j=0;j<D;j++) v[j]=w[j]/n;
  }
  comps.push(v);
  process.stdout.write(`pc${c+1} done\r`);
}
// project + normalize to [-1,1]
const proj=toks.map((t,i)=>comps.map(v=>{ let s=0; let mv=0; for(let j=0;j<D;j++) mv+=mean[j]*v[j]; s=-mv; for(const j of rows[i]) s+=v[j]; return s; }));
const mins=[0,1,2].map(k=>Math.min(...proj.map(p=>p[k]))), maxs=[0,1,2].map(k=>Math.max(...proj.map(p=>p[k])));
const out=proj.map(p=>p.map((v,k)=>Math.round(((v-mins[k])/(maxs[k]-mins[k])*2-1)*1000)/1000));
fs.writeFileSync(path.join(ROOT,"site/data/obs.json"), JSON.stringify({n:N, pos:out}));
console.log(`\nobs.json ${(fs.statSync(path.join(ROOT,"site/data/obs.json")).size/1024).toFixed(0)}KB`);
