/* ============================================================================
 * Array Operator — Trends professional REPORT (trends-report.js)
 *
 * The headline of the Trends tab. The lead instrument is ONE combined chart:
 *   • BARS  — total production each month (left axis, kWh)
 *   • LINE  — year-over-year % change for that same month (right axis, %),
 *             drawn ON TOP of the bars with a dark halo so it's never hidden.
 *             May shows +5% when this May beat last May by 5%.
 * Plus a daily-output bar chart below it. Every chart has FULLY LABELED AXES
 * (titles + units + ticks + gridlines). Static/crisp, redraws on resize.
 * Public: window.AOReport.mount(host, payload, core)
 * ==========================================================================*/
(function () {
  "use strict";

  const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  function css(name, fb){ try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch(e){ return fb; } }
  const INK = () => css("--ink", "#eaf0f7");
  const MUTED = () => css("--muted", "#8b97a8");
  const FAINT = () => css("--faint", "#6b7686");
  const GOOD = () => css("--good", "#3fd68a");
  const BAD = () => css("--bad", "#ff6b6b");
  // Grid/axis/halo are theme-aware: on the light (day) skin a white grid is
  // invisible and a near-black halo makes the YoY line + % labels read muddy,
  // so flip to dark-on-light grid/axis and a WHITE halo (the page cut-out).
  const isDay = () => document.documentElement.getAttribute("data-theme") === "day";
  const GRID = () => isDay() ? "rgba(15,23,42,.07)" : "rgba(255,255,255,.07)";
  const AXIS = () => isDay() ? "rgba(15,23,42,.22)" : "rgba(255,255,255,.20)";
  const HALO = () => isDay() ? "rgba(255,255,255,.95)" : "rgba(7,11,17,.88)";
  // YoY-line/label accent. The day theme repoints --gold2 to a deep brown
  // (#b45309) for "deep warn" chrome — too dark/muddy as a chart line + labels —
  // so use a clean, vivid amber in day; keep the light gold at night.
  const GOLD2 = () => isDay() ? "#e08008" : "#ffd479";

  function fmt0(n){ return n==null?"—":Number(n).toLocaleString(undefined,{maximumFractionDigits:0}); }
  function kCompact(n){ if(n==null) return "—"; const a=Math.abs(n);
    if(a>=1e6) return (n/1e6).toFixed(a>=1e7?0:1).replace(/\.0$/,"")+"M";
    if(a>=1e3) return (n/1e3).toFixed(a>=1e4?0:1).replace(/\.0$/,"")+"k";
    return String(Math.round(n)); }
  function hexA(hex,a){ if(!hex||hex[0]!=="#") return hex||`rgba(63,214,138,${a})`;
    const h=hex.replace("#",""); const r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);
    return `rgba(${r},${g},${b},${a})`; }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function niceMax(v){ if(v<=0) return 1; const exp=Math.floor(Math.log10(v)); const f=v/Math.pow(10,exp);
    const nf = f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10; return nf*Math.pow(10,exp); }

  // Redraw-on-demand hi-DPI canvas (static).
  function makeCanvas(host, aspect, minH, maxH) {
    const cv = document.createElement("canvas");
    cv.style.width = "100%"; cv.style.display = "block"; cv.style.cursor = "crosshair";
    host.appendChild(cv);
    const ctx = cv.getContext("2d");
    let w=0,h=0,dpr=1,drawFn=null;
    function fit(){
      const cssW = host.clientWidth || 720;
      let cssH = Math.max(minH||200, Math.min(maxH||340, cssW/(aspect||2.4)));
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio||1));
      w=cssW; h=cssH; cv.style.height=cssH+"px"; cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr);
      redraw();
    }
    function redraw(){ if(!ctx) return; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h); if(drawFn) drawFn(ctx,w,h); }
    let ro=null;
    if(window.ResizeObserver){ ro=new ResizeObserver(fit); ro.observe(host); } else window.addEventListener("resize",fit);
    fit();
    return { cv, ctx, get w(){return w;}, get h(){return h;}, set draw(fn){ drawFn=fn; redraw(); }, redraw,
             destroy(){ if(ro) ro.disconnect(); else window.removeEventListener("resize",fit); } };
  }
  function roundRect(ctx,x,y,w,h,r){ r=Math.min(r,w/2,Math.abs(h)/2); if(r<0)r=0;
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function strokeSegs(ctx, pts){ ctx.beginPath(); let started=false;
    pts.forEach(p=>{ if(!p){started=false;return;} if(!started){ctx.moveTo(p[0],p[1]);started=true;} else ctx.lineTo(p[0],p[1]); }); ctx.stroke(); }
  function mkTip(host){ host.style.position="relative"; const t=document.createElement("div"); t.className="rp-tip"; t.style.display="none"; host.appendChild(t); return t; }
  function emptyMsg(ctx,w,h,msg){ ctx.fillStyle=FAINT(); ctx.font="13px "+FONT; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(msg, w/2, h/2); }

  // ── THE COMBINED CHART — monthly production bars + YoY-% line ────────────────
  function monthlyCombo(host, monthly, years) {
    const cvs = makeCanvas(host, 2.35, 250, 380);
    const tip = mkTip(host);
    let hover = -1;
    const ly = years.length ? years[years.length-1] : null;
    const py = years.length>=2 ? years[years.length-2] : null;
    const lyM={}, pyM={};
    (monthly[String(ly)]||[]).forEach(p=>lyM[p.month]=p.kwh||0);
    if(py!=null) (monthly[String(py)]||[]).forEach(p=>pyM[p.month]=p.kwh||0);
    const data = MON3.map((lbl,i)=>{ const m=i+1;
      const kwh = lyM[m]!=null?lyM[m]:null; const prev = pyM[m];
      const pct = (py!=null && prev!=null && prev>0 && kwh!=null) ? 100*(kwh-prev)/prev : null;
      return { label:lbl, kwh, prev, pct }; });

    const padL=58, padR=58, padT=26, padB=50;
    function geom(w,h){ return { x0:padL, y0:padT, plotW:w-padL-padR, plotH:h-padT-padB }; }

    cvs.draw = (ctx,w,h) => {
      const kvals = data.map(d=>d.kwh).filter(v=>v!=null);
      if(!kvals.length){ emptyMsg(ctx,w,h,"No monthly production logged yet — connect your arrays to start building history."); return; }
      const G = geom(w,h); const {x0,y0,plotW,plotH} = G;
      const kwhMax = niceMax(Math.max(...kvals)*1.14)||1;
      const pcts = data.map(d=>d.pct).filter(v=>v!=null);
      const pctMag = pcts.length ? niceMax(Math.max(10, Math.max(...pcts.map(Math.abs))*1.4)) : 20;
      const kToY = v => y0+plotH-(v/kwhMax)*plotH;
      const pToY = v => (y0+plotH/2) - (v/pctMag)*(plotH/2);  // % axis centred, 0% at mid-height
      const slot = plotW/12, cx = i => x0+slot*i+slot/2;

      // left gridlines + kWh ticks
      ctx.font="11px "+FONT; ctx.textBaseline="middle";
      for(let i=0;i<=4;i++){ const v=kwhMax*i/4, y=kToY(v);
        ctx.strokeStyle=GRID(); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x0+plotW,y); ctx.stroke();
        ctx.fillStyle=FAINT(); ctx.textAlign="right"; ctx.fillText(kCompact(v), x0-9, y); }
      // right % ticks
      for(let i=-2;i<=2;i++){ const v=pctMag*i/2, y=pToY(v);
        ctx.fillStyle=hexA(GOLD2(),0.9); ctx.textAlign="left"; ctx.fillText((v>0?"+":"")+Math.round(v)+"%", x0+plotW+9, y); }
      // dashed 0% reference (gold)
      const yz=pToY(0); ctx.strokeStyle=hexA(GOLD2(),0.28); ctx.setLineDash([4,4]); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(x0,yz); ctx.lineTo(x0+plotW,yz); ctx.stroke(); ctx.setLineDash([]);
      // axis frame (both verticals + baseline)
      ctx.strokeStyle=AXIS(); ctx.lineWidth=1.25; ctx.beginPath();
      ctx.moveTo(x0,y0); ctx.lineTo(x0,y0+plotH); ctx.lineTo(x0+plotW,y0+plotH); ctx.lineTo(x0+plotW,y0); ctx.stroke();

      // BARS — monthly production (left axis), drawn first
      const bw=Math.min(slot*0.56,36);
      data.forEach((d,i)=>{ if(d.kwh==null) return; const on=i===hover; const bh=(d.kwh/kwhMax)*plotH;
        const g=ctx.createLinearGradient(0,y0+plotH-bh,0,y0+plotH);
        g.addColorStop(0, on?hexA(GOOD(),0.98):hexA(GOOD(),0.6)); g.addColorStop(1, hexA(GOOD(),0.12));
        ctx.fillStyle=g; roundRect(ctx, cx(i)-bw/2, y0+plotH-bh, bw, Math.max(bh,1.5), 3); ctx.fill(); });

      // X month labels
      ctx.fillStyle=MUTED(); ctx.textAlign="center"; ctx.textBaseline="top"; ctx.font="11px "+FONT;
      data.forEach((d,i)=> ctx.fillText(d.label.slice(0,1), cx(i), y0+plotH+8));

      // LINE — YoY % (right axis), drawn LAST = on top, with a dark halo so it
      // reads clearly OVER the bars and is never hidden behind them.
      const pts = data.map((d,i)=> d.pct==null?null:[cx(i), pToY(d.pct)]);
      ctx.lineJoin="round"; ctx.lineCap="round";
      ctx.strokeStyle=HALO(); ctx.lineWidth=6; strokeSegs(ctx, pts);          // halo
      ctx.strokeStyle=GOLD2(); ctx.lineWidth=2.75; ctx.shadowColor=hexA(GOLD2(),0.55); ctx.shadowBlur=8;
      strokeSegs(ctx, pts); ctx.shadowBlur=0;                                // bright line
      pts.forEach((p,i)=>{ if(!p) return; const on=i===hover; const d=data[i];
        ctx.fillStyle=HALO(); ctx.beginPath(); ctx.arc(p[0],p[1], on?6.5:5, 0,7); ctx.fill();
        ctx.fillStyle=GOLD2(); ctx.beginPath(); ctx.arc(p[0],p[1], on?4.5:3.2, 0,7); ctx.fill();
        // % value label above each marker (so "May +5%" reads at a glance)
        ctx.font="600 10.5px "+FONT; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillStyle=HALO(); for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) ctx.fillText((d.pct>=0?"+":"")+Math.round(d.pct)+"%", p[0]+dx, p[1]-9+dy);
        ctx.fillStyle=GOLD2(); ctx.fillText((d.pct>=0?"+":"")+Math.round(d.pct)+"%", p[0], p[1]-9); });

      // hover guideline
      if(hover>=0){ const x=cx(hover); ctx.strokeStyle=GRID(); ctx.lineWidth=1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(x,y0); ctx.lineTo(x,y0+plotH); ctx.stroke(); ctx.setLineDash([]); }

      // ── axis titles ──
      ctx.textBaseline="alphabetic"; ctx.font="600 12px "+FONT;
      ctx.fillStyle=INK(); ctx.textAlign="center"; ctx.fillText("Month", x0+plotW/2, h-12);
      ctx.save(); ctx.translate(14, y0+plotH/2); ctx.rotate(-Math.PI/2); ctx.fillStyle=GOOD();
        ctx.textAlign="center"; ctx.fillText("Monthly production (kWh)", 0, 0); ctx.restore();
      ctx.save(); ctx.translate(w-13, y0+plotH/2); ctx.rotate(Math.PI/2); ctx.fillStyle=GOLD2();
        ctx.textAlign="center"; ctx.fillText("Change vs last year (%)", 0, 0); ctx.restore();
    };

    // hover by nearest month
    cvs.cv.addEventListener("mousemove",(ev)=>{ const r=cvs.cv.getBoundingClientRect(); const x=ev.clientX-r.left;
      const G=geom(cvs.w,cvs.h); const i=Math.floor((x-G.x0)/(G.plotW/12));
      if(i>=0&&i<12){ if(i!==hover){hover=i; cvs.redraw();} const d=data[i];
        if(d.kwh==null && d.pct==null){ tip.style.display="none"; return; }
        let html=`<div class="rp-tip-h">${MON3[i]} ${ly}</div>`;
        html+=`<div class="rp-tip-row"><span class="rp-sw" style="background:${GOOD()}"></span>Production: <b>${d.kwh==null?'—':fmt0(d.kwh)+' kWh'}</b></div>`;
        if(d.pct!=null) html+=`<div class="rp-tip-row"><span class="rp-sw rp-sw-line" style="background:${GOLD2()}"></span>vs ${py}: <b class="${d.pct>=0?'pos':'neg'}">${d.pct>=0?'+':''}${d.pct.toFixed(1)}%</b> (${fmt0(d.prev)} kWh)</div>`;
        tip.innerHTML=html; tip.style.display="block"; const tx=Math.min(Math.max(x,80),cvs.w-80); tip.style.left=tx+"px"; tip.style.top="6px";
      } else if(hover!==-1){ hover=-1; cvs.redraw(); tip.style.display="none"; } });
    cvs.cv.addEventListener("mouseleave",()=>{ if(hover!==-1){hover=-1; cvs.redraw();} tip.style.display="none"; });
    return ()=>cvs.destroy();
  }

  // ── daily output bars (kept; labeled axes) ───────────────────────────────────
  function dailyBar(host, daily) {
    const pts = (daily||[]).filter(p=>p&&p.day).slice(-31);
    const cvs = makeCanvas(host, 3.0, 190, 280);
    const tip = mkTip(host);
    let hover = -1;
    const padL=58, padR=16, padT=14, padB=48;
    cvs.draw = (ctx,w,h) => {
      if(!pts.length){ emptyMsg(ctx,w,h,"No daily production logged yet."); return; }
      const x0=padL,y0=padT,plotW=w-padL-padR,plotH=h-padT-padB;
      const ymax=niceMax(Math.max(...pts.map(p=>p.kwh||0))*1.12)||1;
      const yToPx=v=>y0+plotH-(v/ymax)*plotH;
      ctx.font="11px "+FONT; ctx.textBaseline="middle";
      for(let i=0;i<=4;i++){ const v=ymax*i/4,y=yToPx(v);
        ctx.strokeStyle=GRID(); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x0+plotW,y); ctx.stroke();
        ctx.fillStyle=FAINT(); ctx.textAlign="right"; ctx.fillText(kCompact(v), x0-9, y); }
      ctx.strokeStyle=AXIS(); ctx.lineWidth=1.25; ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x0,y0+plotH); ctx.lineTo(x0+plotW,y0+plotH); ctx.stroke();
      const slot=plotW/pts.length, bw=Math.min(slot*0.62,26);
      pts.forEach((p,i)=>{ const v=p.kwh||0,x=x0+slot*i+slot/2,bh=(v/ymax)*plotH,on=i===hover;
        const g=ctx.createLinearGradient(0,y0+plotH-bh,0,y0+plotH); g.addColorStop(0,on?"#fff":GOOD()); g.addColorStop(1,hexA(GOOD(),on?0.7:0.42));
        ctx.fillStyle=g; ctx.shadowColor=hexA(GOOD(),0.4); ctx.shadowBlur=on?12:5;
        roundRect(ctx,x-bw/2,y0+plotH-bh,bw,Math.max(bh,1.5),3); ctx.fill(); ctx.shadowBlur=0; });
      ctx.fillStyle=MUTED(); ctx.textAlign="center"; ctx.textBaseline="top"; ctx.font="11px "+FONT;
      const everyN=pts.length>14?Math.ceil(pts.length/8):2;
      pts.forEach((p,i)=>{ if(i%everyN!==0 && i!==pts.length-1) return; const d=new Date(p.day+"T00:00:00");
        ctx.fillText(isNaN(d)?p.day.slice(5):`${MON3[d.getMonth()]} ${d.getDate()}`, x0+slot*i+slot/2, y0+plotH+8); });
      ctx.fillStyle=INK(); ctx.font="600 12px "+FONT; ctx.textAlign="center"; ctx.textBaseline="alphabetic"; ctx.fillText("Date", x0+plotW/2, h-12);
      ctx.save(); ctx.translate(14,y0+plotH/2); ctx.rotate(-Math.PI/2); ctx.textAlign="center"; ctx.fillText("kWh",0,0); ctx.restore();
    };
    cvs.cv.addEventListener("mousemove",(ev)=>{ if(!pts.length) return; const r=cvs.cv.getBoundingClientRect(); const x=ev.clientX-r.left;
      const plotW=cvs.w-padL-padR, i=Math.floor((x-padL)/(plotW/pts.length));
      if(i>=0&&i<pts.length){ if(i!==hover){hover=i; cvs.redraw();} const p=pts[i]; const d=new Date(p.day+"T00:00:00");
        const lbl=isNaN(d)?p.day:d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
        tip.innerHTML=`<div class="rp-tip-h">${esc(lbl)}</div><div class="rp-tip-v">${fmt0(p.kwh)} kWh</div>`;
        tip.style.display="block"; const tx=Math.min(Math.max(x,70),cvs.w-70); tip.style.left=tx+"px"; tip.style.top="6px";
      } else if(hover!==-1){ hover=-1; cvs.redraw(); tip.style.display="none"; } });
    cvs.cv.addEventListener("mouseleave",()=>{ if(hover!==-1){hover=-1; cvs.redraw();} tip.style.display="none"; });
    return ()=>cvs.destroy();
  }

  function mount(host, payload, core) {
    const monthly = payload.monthly_by_year || {};
    const years = (payload.years||[]).slice().sort((a,b)=>a-b);
    const daily = payload.daily_series && payload.daily_series.length ? payload.daily_series : (payload.daily_recent||[]);
    const ly = years.length?years[years.length-1]:null, py = years.length>=2?years[years.length-2]:null;

    const el = document.createElement("div");
    el.className = "rp-wrap";
    el.innerHTML = `
      <div class="rp-card">
        <div class="rp-card-h">
          <h3 class="rp-card-t">Monthly production &amp; year-over-year change</h3>
          <span class="rp-card-sub">Bars: total production each month${ly!=null?` (${ly})`:""}.${py!=null?` Line: % change vs the same month in ${py}.`:" Year-over-year line appears once you have a second year of history."}</span>
          <div class="rp-legend">
            <span class="rp-leg"><span class="rp-sw" style="background:${GOOD()}"></span>Production (kWh)</span>
            <span class="rp-leg"><span class="rp-sw rp-sw-line" style="background:${GOLD2()}"></span>YoY change (%)</span>
          </div>
        </div>
        <div class="rp-chart" id="rpCombo"></div>
      </div>
      <div class="rp-card">
        <div class="rp-card-h"><h3 class="rp-card-t">Daily output</h3>
          <span class="rp-card-sub">Energy produced each day — last ${Math.min((daily||[]).length,31)} days</span></div>
        <div class="rp-chart" id="rpDaily"></div>
      </div>`;
    host.appendChild(el);

    const stops = [];
    stops.push(monthlyCombo(el.querySelector("#rpCombo"), monthly, years));
    stops.push(dailyBar(el.querySelector("#rpDaily"), daily));
    return function stop(){ stops.forEach(s=>{ try{ s&&s(); }catch(e){} }); try{ el.remove(); }catch(e){} };
  }

  window.AOReport = { mount };
})();
