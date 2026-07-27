/* Passport page runtime: traits, live stance, sales, canvas share card */
(function(){
  var C=window.CAT; if(!C) return;
  function $(id){return document.getElementById(id);}
  // traits
  var tg=$('tgrid');
  tg.innerHTML=Object.entries(C.traits).map(function(kv){
    return '<div class="trait"><div class="k">'+HT.esc(kv[0])+'</div><div class="v">'+HT.esc(kv[1])+'</div></div>';
  }).join('');
  // sales (re-rendered after live upgrade)
  function renderSales(){
    var sb=$('salebox');
    if(C.sales && C.sales.length){
      sb.innerHTML='<h2>Sale history (HYPE)</h2>'+C.sales.slice().reverse().map(function(s){
        return '<div class="srow"><span class="d">'+HT.fmtD(s.t)+'</span><span class="p">'+s.p.toLocaleString()+' HYPE</span></div>';
      }).join('');
    } else { sb.innerHTML='<h2>Sale history</h2><div class="srow"><span class="d">No on-chain HYPE sales yet'+(C.diamond?', still in the hand it was dealt.':'.')+'</span></div>'; }
  }
  renderSales();
  // rebuild the diamond/traded + last-sale chips from current C
  function renderChips(){
    var chips=document.querySelector('.chips'); if(!chips) return;
    var dc=chips.querySelector('.chip.dia, .chip.fire');
    if(dc){ if(C.diamond){ dc.className='chip dia'; dc.innerHTML='💎 never traded'; }
      else { dc.className='chip fire'; dc.innerHTML='🔥 traded '+C.flips+'×'; } }
    var last=C.sales&&C.sales.length?C.sales[C.sales.length-1].p:0;
    var gc=chips.querySelector('.chip.gold');
    if(last){ if(!gc){ gc=document.createElement('span'); gc.className='chip gold'; chips.appendChild(gc); }
      gc.innerHTML='last sale <b>'+last.toLocaleString()+' HYPE</b>'; }
    else if(gc){ gc.remove(); }
  }
  // ---- live upgrade: static pages bake owner/sales/flips at index time; refresh from JSON ----
  Promise.all([
    HT.json('/data/owners.json',true).catch(function(){return null;}),
    HT.json('/data/sales.json',true).catch(function(){return null;}),
    HT.json('/data/flips.json',true).catch(function(){return null;})
  ]).then(function(r){
    var OWN=r[0], SALES=r[1], FL=r[2];
    if(OWN){ var o=(OWN.owners||OWN)[C.id];
      if(o){ C.owner=o; var oc=document.querySelector('.ownerline code'); if(oc) oc.textContent=HT.short(o);
        var stale=document.querySelector('.ownerline .stale'); if(stale) stale.remove(); } }
    if(FL && FL.flips){ var f=FL.flips[C.id]; if(typeof f==='number'){ C.flips=f; C.diamond=(f===0); } }
    if(SALES && SALES.byToken){ C.sales=(SALES.byToken[C.id]||[]).map(function(x){return {t:x.ts,p:x.price};}); }
    renderSales(); renderChips(); drawCard();
  }).catch(function(){});
  // live stance
  var stanceTxt='sitting flat', stanceCls='';
  HT.json('/data/cat_states.json', true).then(function(cs){
    var st=(cs.states||'')[C.id-1]||'0';
    var el=$('stance');
    if(st==='1'){stanceTxt='owner live · net long';stanceCls='long';}
    else if(st==='2'){stanceTxt='owner live · net short';stanceCls='short';}
    el.innerHTML='<i class="sdot"></i>'+stanceTxt;
    if(stanceCls) el.classList.add(stanceCls);
    drawCard(); // refresh card with stance
  }).catch(function(){ $('stance').innerHTML='<i class="sdot"></i>sitting flat'; drawCard(); });
  // copy link
  $('copyBtn').onclick=function(){
    var u='https://hypurrterminal.xyz/cat/'+C.id;
    (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){ $('copyBtn').textContent='Copied ✓'; setTimeout(function(){$('copyBtn').textContent='Copy link';},1600); });
  };
  // ---- canvas passport card (1000x1250, 4:5) ----
  var art=new Image(); art.src='/img/'+C.id+'.webp'; var artReady=false;
  art.onload=function(){artReady=true; drawCard();};
  function rr(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
  function drawCard(){
    var cv=$('pp'), ctx=cv.getContext('2d');
    ctx.fillStyle='#0E0B08'; ctx.fillRect(0,0,1000,1250);
    var g1=ctx.createRadialGradient(870,120,0,870,120,700); g1.addColorStop(0,'rgba(84,224,203,.14)'); g1.addColorStop(1,'rgba(84,224,203,0)');
    ctx.fillStyle=g1; ctx.fillRect(0,0,1000,1250);
    var g2=ctx.createRadialGradient(90,1180,0,90,1180,600); g2.addColorStop(0,'rgba(237,190,114,.12)'); g2.addColorStop(1,'rgba(237,190,114,0)');
    ctx.fillStyle=g2; ctx.fillRect(0,0,1000,1250);
    // art
    if(artReady){ ctx.save(); rr(ctx,150,90,700,700,44); ctx.clip(); ctx.drawImage(art,150,90,700,700); ctx.restore();
      ctx.strokeStyle='rgba(245,239,228,.14)'; ctx.lineWidth=3; rr(ctx,150,90,700,700,44); ctx.stroke(); }
    // name
    ctx.fillStyle='#F5EFE4'; ctx.font='700 88px "Bricolage Grotesque", DejaVu Sans, sans-serif'; ctx.textAlign='center';
    ctx.fillText('Hypurr #'+C.id, 500, 910);
    // stance-colored chip row
    ctx.font='600 34px Inter, DejaVu Sans, sans-serif';
    var bits=['rank #'+C.rr, C.diamond?'💎 never traded':'🔥 traded '+C.flips+'×'];
    if(C.sales&&C.sales.length) bits.push('last '+C.sales[C.sales.length-1].p+' HYPE');
    bits.push(stanceTxt.replace('owner live · ',''));
    ctx.fillStyle= stanceCls==='long' ? '#54E0CB' : stanceCls==='short' ? '#F2856F' : '#B0A48D';
    ctx.fillText(bits.join('  ·  '), 500, 975);
    // brand footer
    ctx.fillStyle='#54E0CB'; ctx.font='700 30px Inter, DejaVu Sans, sans-serif';
    ctx.fillText('THE PRIDE NEVER SLEEPS', 500, 1105);
    ctx.fillStyle='#F5EFE4'; ctx.font='700 44px "Bricolage Grotesque", DejaVu Sans, sans-serif';
    ctx.fillText('hypurrterminal.xyz/cat/'+C.id, 500, 1165);
    ctx.strokeStyle='rgba(84,224,203,.8)'; ctx.lineWidth=6;
    ctx.beginPath(); ctx.moveTo(0,1247); ctx.lineTo(1000,1247); ctx.stroke();
  }
  drawCard();
  // Share UX: native share sheet is a phone pattern; on desktop it opens a clunky
  // OS dialog, so there the card simply downloads. Plus a real "Post on X" action.
  var phone = matchMedia('(pointer:coarse)').matches && !!navigator.canShare;
  var shareBtn=$('shareBtn');
  if(!phone) shareBtn.textContent='Download card';
  shareBtn.onclick=function(){
    var cv=$('pp');
    cv.toBlob(function(blob){
      var file=new File([blob],'hypurr-'+C.id+'-passport.png',{type:'image/png'});
      if(phone && navigator.canShare({files:[file]})){
        navigator.share({files:[file], title:'Hypurr #'+C.id, text:'Hypurr #'+C.id+' on Hypurr Terminal', url:'https://hypurrterminal.xyz/cat/'+C.id}).catch(function(){});
      } else {
        var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hypurr-'+C.id+'-passport.png'; a.click();
        shareBtn.textContent='Saved ✓'; setTimeout(function(){shareBtn.textContent=phone?'Share passport ↗':'Download card';},1600);
      }
    },'image/png');
  };
  // "Post on X" (added here so all 4,600 static pages get it without regeneration)
  var acts=document.querySelector('.actions');
  if(acts && !document.getElementById('xBtn')){
    var xb=document.createElement('a'); xb.id='xBtn'; xb.className='btn ghost'; xb.target='_blank'; xb.rel='noopener';
    var txt='Hypurr #'+C.id+' · rarity #'+C.rr+(C.diamond?' · never left the hand it was dealt 💎':'')+' · the pride never sleeps';
    xb.href='https://x.com/intent/tweet?text='+encodeURIComponent(txt)+'&url='+encodeURIComponent('https://hypurrterminal.xyz/cat/'+C.id);
    xb.textContent='Post on X ↗';
    acts.appendChild(xb);
  }
})();
