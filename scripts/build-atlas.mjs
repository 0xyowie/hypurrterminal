// Pack all 4,600 Hypurr thumbs into texture atlases + per-cat avg colors.
import fs from "node:fs"; import sharp from "sharp";
const N=4600, COLS=68, ROWS=Math.ceil(N/COLS); // 68x68 = 4624 cells
async function buildAtlas(cell, out){
  const W=COLS*cell, H=ROWS*cell;
  const buf=Buffer.alloc(W*H*4);
  for(let i=0;i<N;i++){
    const id=i+1;
    const img=await sharp(`site/img/${id}.webp`).resize(cell,cell).ensureAlpha().raw().toBuffer();
    const cx=(i%COLS)*cell, cy=Math.floor(i/COLS)*cell;
    for(let y=0;y<cell;y++){
      img.copy(buf, ((cy+y)*W+cx)*4, y*cell*4, (y+1)*cell*4);
    }
    if(id%400===0) process.stdout.write(`  ${out}: ${id}/${N}\r`);
  }
  await sharp(buf,{raw:{width:W,height:H,channels:4}}).webp({quality:62}).toFile(out);
  const kb=Math.round(fs.statSync(out).size/1024);
  console.log(`\n${out} ${W}x${H} ${kb}KB`);
}
console.log("building atlases…");
await buildAtlas(48, "site/assets/atlas48.webp");
await buildAtlas(24, "site/assets/atlas24.webp");
// avg colors (slightly saturated for ember look)
const colors=[];
for(let i=1;i<=N;i++){
  const px=await sharp(`site/img/${i}.webp`).resize(1,1).raw().toBuffer();
  colors.push([px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,"0")).join(""));
  if(i%800===0) process.stdout.write(`  colors ${i}/${N}\r`);
}
fs.writeFileSync("site/assets/atlas_meta.json", JSON.stringify({n:N,cols:COLS,rows:ROWS,colors}));
console.log(`\natlas_meta.json ${(fs.statSync("site/assets/atlas_meta.json").size/1024).toFixed(0)}KB`);
