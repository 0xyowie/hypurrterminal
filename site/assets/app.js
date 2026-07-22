/* Hypurr Terminal — shared runtime: consent-gated GA, cookie banner, nav, helpers */
(function(){
  var GA_ID='G-N4VNS4KXWH', CK='hypurr_cookie_consent';

  // --- Google Analytics, consent-default denied until accepted ---
  window.dataLayer=window.dataLayer||[];
  window.gtag=function(){dataLayer.push(arguments);};
  gtag('consent','default',{'analytics_storage':'denied'});
  function loadGA(){
    if(window.__gaOn)return; window.__gaOn=true;
    gtag('consent','update',{'analytics_storage':'granted'});
    var s=document.createElement('script'); s.async=true;
    s.src='https://www.googletagmanager.com/gtag/js?id='+GA_ID; document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  // --- cookie banner ---
  function injectBanner(){
    if(document.getElementById('cookie'))return;
    var d=document.createElement('div'); d.id='cookie';
    d.innerHTML='<div class="cc-txt">We’d like to use <b>Google Analytics</b> to understand how the terminal gets used. It sets analytics cookies and <b>only loads if you accept</b>. Decline and only essential local storage is used. See our <a href="/privacy">Privacy &amp; Cookies</a> notice.</div>'+
      '<div class="cc-btns"><button class="cc-b" id="cc-no">Decline</button><button class="cc-b ok" id="cc-yes">Accept</button></div>';
    document.body.appendChild(d);
    d.querySelector('#cc-yes').onclick=function(){choose('accepted');};
    d.querySelector('#cc-no').onclick=function(){choose('declined');};
  }
  function choose(v){ try{localStorage.setItem(CK,v)}catch(e){} var c=document.getElementById('cookie'); if(c)c.classList.remove('show'); if(v==='accepted')loadGA(); }
  window.HTConsent={ manage:function(){ injectBanner(); document.getElementById('cookie').classList.add('show'); } };

  // --- active nav ---
  function markNav(){
    var pg=document.body.getAttribute('data-page'); if(!pg)return;
    // older generated pages may still carry links to retired sections — drop them
    ['pulse','observatory'].forEach(function(k){
      var st=document.querySelector('nav.top a[data-nav="'+k+'"]'); if(st) st.remove();
    });
    var links=document.querySelectorAll('nav.top a[data-nav]');
    for(var i=0;i<links.length;i++){ if(links[i].getAttribute('data-nav')===pg) links[i].classList.add('active'); }
  }

  // --- mobile hamburger menu (content pages) ---
  function setupNav(){
    var bar=document.querySelector('header.site .bar');
    var nav=bar && bar.querySelector('nav.top');
    if(!bar || !nav) return;
    var btn=document.createElement('button');
    btn.className='navtoggle'; btn.type='button'; btn.setAttribute('aria-label','Menu'); btn.setAttribute('aria-expanded','false');
    btn.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
    bar.appendChild(btn);
    function close(){ nav.classList.remove('navopen'); btn.classList.remove('on'); btn.setAttribute('aria-expanded','false'); }
    btn.addEventListener('click', function(e){ e.stopPropagation(); var open=nav.classList.toggle('navopen'); btn.classList.toggle('on',open); btn.setAttribute('aria-expanded',open?'true':'false'); });
    nav.addEventListener('click', function(e){ if(e.target.tagName==='A') close(); });
    document.addEventListener('click', function(e){ if(!nav.contains(e.target) && !btn.contains(e.target)) close(); });
  }

  // --- back-gesture closes an open modal (mobile) ---
  // usage: var back=HT.backClose(modalEl, hideFn); call back.onOpen() after showing; wire ×/backdrop/Esc to back.close()
  function backClose(modalEl, hide){
    var isOpen=function(){ return modalEl.classList.contains('open'); };
    var pushed=false; // one history entry per modal SESSION, not per openCat call
    window.addEventListener('popstate', function(){ pushed=false; if(isOpen()) hide(); });
    return {
      onOpen:function(){ if(pushed) return; try{ history.pushState({htModal:1},''); pushed=true; }catch(e){} },
      close:function(){ if(!isOpen()) return; if(pushed){ try{ history.back(); return; }catch(e){} } hide(); }
    };
  }

  function ready(fn){ if(document.readyState!=='loading')fn(); else document.addEventListener('DOMContentLoaded',fn); }
  ready(function(){
    markNav();
    setupNav();
    var prior=null; try{prior=localStorage.getItem(CK)}catch(e){}
    if(prior==='accepted'){ loadGA(); }
    else if(!prior){ injectBanner(); document.getElementById('cookie').classList.add('show'); }
    // 'declined' -> load nothing, show nothing
  });

  // --- shared helpers for pages ---
  window.HT={
    img:function(id){ return '/img/'+id+'.webp'; },
    esc:function(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); },
    short:function(a){ return a? a.slice(0,6)+'…'+a.slice(-4) : 'unknown'; },
    money:function(n){ return n>=1e9?'$'+(n/1e9).toFixed(2)+'B':n>=1e6?'$'+(n/1e6).toFixed(1)+'M':n>=1e3?'$'+(n/1e3).toFixed(0)+'k':'$'+Math.round(n); },
    num:function(n){ return Number(n).toLocaleString('en-US'); },
    pct:function(x){ return Math.round(x*100); },
    fmtD:function(ts){ return new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); },
    json:function(p,fresh){ return fetch(p, fresh?{cache:'no-cache'}:undefined).then(function(r){ if(!r.ok) throw new Error(p+' '+r.status); return r.json(); }); },
    backClose:backClose
  };
})();
