// PCA on one-hot trait vectors -> 2D star-map layout for the Observatory.
// v2: project to 2 components, then settle every Hypurr onto a collision-free grid
// (nearest free cell to its ideal spot) so neighborhoods survive but nothing overlaps.
import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const toks = JSON.parse(fs.readFileSync(path.join(ROOT,"data/traits.json"))).tokens;
// dims
const dims=[]; const dimIx={};
for(const t of toks) for(const [k,v] of Object.entries(t.traits)){ const key=k+"::"+v; if(!(key in dimIx)){ dimIx[key]=dims.length; dims.push(key); } }
const N=toks.length, D=dims.length;
console.log(`tokens ${N} · one-hot dims ${D}`);
const rows=toks.map(t=>Object.entries(t.traits).map(([k,v])=>dimIx[k+"::"+v]));
const mean=new Float64Array(D);
for(const r of rows) for(const j of r) mean[j]+=1;
for(let j=0;j<D;j++) mean[j]/=N;
function Xv(v){ const out=new Float64Array(N); let mv=0; for(let j=0;j<D;j++) mv+=mean[j]*v[j];
  for(let i=0;i<N;i++){ let s=-mv; for(const j of rows[i]) s+=v[j]; out[i]=s; } return out; }
function XTu(u){ const out=new Float64Array(D); let su=0; for(let i=0;i<N;i++) su+=u[i];
  for(let i=0;i<N;i++) for(const j of rows[i]) out[j]+=u[i];
  for(let j=0;j<D;j++) out[j]-=mean[j]*su; return out; }
const comps=[];
for(let c=0;c<2;c++){
  let v=new Float64Array(D); for(let j=0;j<D;j++) v[j]=Math.random()-0.5;
  for(let it=0; it<60; it++){
    for(const pc of comps){ let d=0; for(let j=0;j<D;j++) d+=v[j]*pc[j]; for(let j=0;j<D;j++) v[j]-=d*pc[j]; }
    const u=Xv(v); const w=XTu(u);
    let n=0; for(let j=0;j<D;j++) n+=w[j]*w[j]; n=Math.sqrt(n)||1;
    for(let j=0;j<D;j++) v[j]=w[j]/n;
  }
  comps.push(v);
  process.stdout.write(`pc${c+1} done\r`);
}
const proj=toks.map((t,i)=>comps.map(v=>{ let mv=0; for(let j=0;j<D;j++) mv+=mean[j]*v[j]; let s=-mv; for(const j of rows[i]) s+=v[j]; return s; }));
// normalize each axis to [0,1] with a light quantile stretch so outliers don't crush the middle
function norm(k){
  const vals=proj.map(p=>p[k]).sort((a,b)=>a-b);
  const lo=vals[Math.floor(N*0.005)], hi=vals[Math.floor(N*0.995)];
  return proj.map(p=>Math.max(0,Math.min(1,(p[k]-lo)/(hi-lo||1))));
}
const nx=norm(0), ny=norm(1);
// grid settle: nearest free cell to the ideal spot (spiral search) => zero overlap, clusters intact
const GW=100, GH=60;
const taken=new Uint8Array(GW*GH);
const pts=new Array(N);
const order=Array.from({length:N},(_,i)=>i); // mint order; dense cluster cores expand outward organically
for(const i of order){
  const ix=Math.round(nx[i]*(GW-1)), iy=Math.round(ny[i]*(GH-1));
  let placed=false;
  for(let r=0;r<Math.max(GW,GH)&&!placed;r++){
    for(let dy=-r;dy<=r&&!placed;dy++){
      for(let dx=-r;dx<=r&&!placed;dx++){
        if(Math.max(Math.abs(dx),Math.abs(dy))!==r) continue;   // ring only
        const x=ix+dx, y=iy+dy;
        if(x<0||y<0||x>=GW||y>=GH) continue;
        if(!taken[y*GW+x]){ taken[y*GW+x]=1; pts[i]=[x,y]; placed=true; }
      }
    }
  }
  if(!placed) throw new Error('grid full for '+i);
}
fs.writeFileSync(path.join(ROOT,"site/data/obs.json"), JSON.stringify({v:2, gw:GW, gh:GH, pts}));
console.log(`\nobs.json v2 ${(fs.statSync(path.join(ROOT,"site/data/obs.json")).size/1024).toFixed(0)}KB · grid ${GW}x${GH} · fill ${(N/(GW*GH)*100).toFixed(0)}%`);
