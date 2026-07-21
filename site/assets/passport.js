/* Passport page runtime: traits, live stance, sales, canvas share card */
(function(){
  var C=window.CAT; if(!C) return;
  function $(id){return document.getElementById(id);}
  // traits
  var tg=$('tgrid');
  tg.innerHTML=Object.entries(C.traits).map(function(kv){
    return '<div class="trait"><div class="k">'+HT.esc(kv[0])+'</div><div class="v">'+HT.esc(kv[1])+'</div></div>';
  }).join('');
  // sales
  var sb=$('salebox');
  if(C.sales && C.sales.length){
    sb.innerHTML='<h3>Sale history (HYPE)</h3>'+C.sales.slice().reverse().map(function(s){
      return '<div class="srow"><span class="d">'+HT.fmtD(s.t)+'</span><span class="p">'+s.p.toLocaleString()+' HYPE</span></div>';
    }).join('');
  } else { sb.innerHTML='<h3>Sale history</h3><div class="srow"><span class="d">No on-chain HYPE sales yet'+(C.diamond?' — still in the hand it was dealt.':'.')+'</span></div>'; }
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
  $('shareBtn').onclick=function(){
    var cv=$('pp');
    cv.toBlob(function(blob){
      var file=new File([blob],'hypurr-'+C.id+'-passport.png',{type:'image/png'});
      if(navigator.canShare && navigator.canShare({files:[file]})){
        navigator.share({files:[file], title:'Hypurr #'+C.id, text:'Hypurr #'+C.id+' on Hypurr Terminal', url:'https://hypurrterminal.xyz/cat/'+C.id}).catch(function(){});
      } else {
        var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hypurr-'+C.id+'-passport.png'; a.click();
      }
    },'image/png');
  };
})();
