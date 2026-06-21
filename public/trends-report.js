/* ============================================================================
 * Array Operator — Trends professional REPORT (trends-report.js)
 *
 * The headline of the Trends tab: a clean, report-grade trio of charts with
 * FULLY LABELED AXES (axis titles + units + tick labels + gridlines), the way a
 * production report should read:
 *   1. Daily output ........ bar chart   (X: date, Y: kWh)
 *   2. Year-over-year growth bar chart   (X: month, Y: growth %)  ← graph #2
 *   3. This year vs last yr  line chart  (X: month, Y: kWh, legend)
 *
 * Static (no animation loop) → crisp, screenshot-ready. Redraws on resize.
 * Reuses window.AOTrends tokens. Public: window.AOReport.mount(host, payload, core)
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
  const GOLD = () => css("--gold", "#f5b942");
  const BAD = () => css("--bad", "#ff6b6b");
  const GRID = "rgba(255,255,255,.07)";
  const AXIS = "rgba(255,255,255,.20)";

  function fmt0(n){ return n==null?"—":Number(n).toLocaleString(undefined,{maximumFractionDigits:0}); }
  function kCompact(n){ if(n==null) return "—"; const a=Math.abs(n);
    if(a>=1e6) return (n/1e6).toFixed(a>=1e7?0:1).replace(/\.0$/,"")+"M";
    if(a>=1e3) return (n/1e3).toFixed(a>=1e4?0:1).replace(/\.0$/,"")+"k";
    return String(Math.round(n)); }
  function hexA(hex,a){ if(!hex||hex[0]!=="#") return hex||`rgba(63,214,138,${a})`;
    const h=hex.replace("#",""); const r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);
    return `rgba(${r},${g},${b},${a})`; }

  // Redraw-on-demand hi-DPI canvas (static, no RAF). Returns {cv, redraw, destroy, mouse}.
  function makeCanvas(host, aspect, minH, maxH) {
    const cv = document.createElement("canvas");
    cv.style.width = "100%"; cv.style.display = "block";
    host.appendChild(cv);
    const ctx = cv.getContext("2d");
    let w=0,h=0,dpr=1,drawFn=null;
    function fit(){
      const cssW = host.clientWidth || 720;
      let cssH = Math.max(minH||200, Math.min(maxH||320, cssW/(aspect||2.4)));
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio||1));
      w=cssW; h=cssH; cv.style.height=cssH+"px";
      cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr);
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

  // "Nice" rounded axis maximum so ticks are human (e.g. 10, 25, 500, 2.5k).
  function niceMax(v){ if(v<=0) return 1; const exp=Math.floor(Math.log10(v)); const f=v/Math.pow(10,exp);
    const nf = f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10; return nf*Math.pow(10,exp); }

  // ── the labeled-axis engine — every chart in this module draws through it ────
  // opts: { xTitle, yTitle, yMin, yMax, ticks, xLabels(i)->str|null, fmtY, zeroLine }
  // returns plot geometry { x0,y0,plotW,plotH, xToPx(i,n), yToPx(v) }
  function frame(ctx, w, h, opts) {
    const padL = 60, padR = 16, padT = 14, padB = 50;
    const x0 = padL, y0 = padT, plotW = w-padL-padR, plotH = h-padT-padB;
    const yMin = opts.yMin || 0, yMax = opts.yMax, ticks = opts.ticks || 4;
    const yToPx = v => y0 + plotH - ((v-yMin)/(yMax-yMin))*plotH;

    ctx.font = "11px "+FONT; ctx.textBaseline = "middle";
    // Y gridlines + tick labels
    for (let i=0;i<=ticks;i++){
      const v = yMin + (yMax-yMin)*i/ticks;
      const y = yToPx(v);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x0+plotW,y); ctx.stroke();
      ctx.fillStyle = FAINT(); ctx.textAlign = "right";
      ctx.fillText((opts.fmtY||kCompact)(v), x0-9, y);
    }
    // zero baseline (for diverging charts)
    if (opts.zeroLine && yMin < 0) {
      const yz = yToPx(0); ctx.strokeStyle = AXIS; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(x0,yz); ctx.lineTo(x0+plotW,yz); ctx.stroke();
    }
    // axis lines
    ctx.strokeStyle = AXIS; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x0,y0+plotH); ctx.lineTo(x0+plotW,y0+plotH); ctx.stroke();
    // X tick labels. xMode "band" → centered in each slot (bars); else evenly
    // spaced points (lines). Positioning is computed HERE so call sites never
    // need the (not-yet-returned) plot geometry.
    if (opts.xLabels) {
      const n = opts.n||1; ctx.fillStyle = MUTED(); ctx.textAlign="center"; ctx.textBaseline="top"; ctx.font="11px "+FONT;
      for (let i=0;i<n;i++){ const lbl = opts.xLabels(i); if(lbl==null) continue;
        const px = opts.xMode === "band"
          ? x0 + plotW*(i+0.5)/n
          : x0 + (n===1?plotW/2:(plotW*i/(n-1)));
        ctx.fillText(lbl, px, y0+plotH+8); }
    }
    // ── AXIS TITLES ──
    ctx.fillStyle = INK(); ctx.font = "600 12px "+FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    if (opts.xTitle) ctx.fillText(opts.xTitle, x0+plotW/2, h-12);
    if (opts.yTitle) { ctx.save(); ctx.translate(15, y0+plotH/2); ctx.rotate(-Math.PI/2);
      ctx.textAlign="center"; ctx.fillText(opts.yTitle, 0, 0); ctx.restore(); }
    return { x0, y0, plotW, plotH, yToPx };
  }

  // ── chart 1: daily output bars ───────────────────────────────────────────────
  function dailyBar(host, daily) {
    const pts = (daily||[]).filter(p=>p&&p.day).slice(-31);   // last ~month, report-friendly
    const cvs = makeCanvas(host, 2.9, 200, 300);
    const tip = mkTip(host);
    let hover = -1;
    cvs.draw = (ctx,w,h) => {
      if (!pts.length){ emptyMsg(ctx,w,h,"No daily production logged yet."); return; }
      const ymax = niceMax(Math.max(...pts.map(p=>p.kwh||0))*1.1) || 1;
      const g = frame(ctx,w,h,{ yTitle:"kWh", xTitle:"Date", yMax:ymax, ticks:4,
        n: pts.length, xMode:"band",
        xLabels:(i)=>{ const everyN = pts.length>14?Math.ceil(pts.length/8):2;
          if(i%everyN!==0 && i!==pts.length-1) return null;
          const d=new Date(pts[i].day+"T00:00:00"); return isNaN(d)?pts[i].day.slice(5):`${MON3[d.getMonth()]} ${d.getDate()}`; } });
      const slot = g.plotW/pts.length; const bw = Math.min(slot*0.62, 26);
      pts.forEach((p,i)=>{ const v=p.kwh||0; const x=g.x0+slot*i+slot/2; const bh=(v/ymax)*g.plotH;
        const on=i===hover; const grad=ctx.createLinearGradient(0,g.y0+g.plotH-bh,0,g.y0+g.plotH);
        grad.addColorStop(0, on?"#ffffff":GOOD()); grad.addColorStop(1, hexA(GOOD(), on?0.7:0.45));
        ctx.fillStyle=grad; ctx.shadowColor=hexA(GOOD(),0.45); ctx.shadowBlur=on?14:6;
        roundRect(ctx, x-bw/2, g.y0+g.plotH-bh, bw, Math.max(bh,1.5), 3); ctx.fill(); ctx.shadowBlur=0; });
    };
    hoverBars(cvs, tip, ()=>pts, 60, 16, (p)=>{ const d=new Date(p.day+"T00:00:00");
      const lbl=isNaN(d)?p.day:d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
      return `<div class="rp-tip-h">${esc(lbl)}</div><div class="rp-tip-v">${fmt0(p.kwh)} kWh</div>`; },
      (h)=>{hover=h; cvs.redraw();});
    return ()=>cvs.destroy();
  }

  // ── chart 2: year-over-year growth (diverging bars, % per month) ─────────────
  function yoyGrowth(host, monthly, years) {
    const cvs = makeCanvas(host, 2.9, 200, 300);
    const tip = mkTip(host);
    let hover = -1;
    if (years.length < 2) { needYears(cvs, "Year-over-year growth compares each month to the same month a year earlier — it appears once you have a second year of history."); return ()=>cvs.destroy(); }
    const ly = years[years.length-1], py = years[years.length-2];
    const lyM={}, pyM={};
    (monthly[String(ly)]||[]).forEach(p=>lyM[p.month]=p.kwh||0);
    (monthly[String(py)]||[]).forEach(p=>pyM[p.month]=p.kwh||0);
    const data = MON3.map((lbl,i)=>{ const m=i+1; const cur=lyM[m], prev=pyM[m];
      const pct = (prev!=null && prev>0 && cur!=null) ? 100*(cur-prev)/prev : null;
      return { label:lbl, pct, cur, prev }; });
    const vals = data.map(d=>d.pct).filter(v=>v!=null);
    const cvs2=cvs;
    cvs.draw = (ctx,w,h) => {
      if(!vals.length){ emptyMsg(ctx,w,h,`No overlapping months between ${ly} and ${py} yet.`); return; }
      const mag = niceMax(Math.max(20, Math.max(...vals.map(Math.abs))*1.15));
      const g = frame(ctx,w,h,{ yTitle:"YoY growth %", xTitle:`Month (${ly} vs ${py})`, yMin:-mag, yMax:mag, ticks:4,
        fmtY:(v)=>(v>0?"+":"")+Math.round(v)+"%", zeroLine:true, n:12, xMode:"band",
        xLabels:(i)=>data[i].label.slice(0,1) });
      const slot=g.plotW/12; const bw=Math.min(slot*0.6,30); const yz=g.yToPx(0);
      data.forEach((d,i)=>{ if(d.pct==null) return; const x=g.x0+slot*i+slot/2;
        const y=g.yToPx(d.pct); const up=d.pct>=0; const col=up?GOOD():BAD(); const on=i===hover;
        ctx.fillStyle=hexA(col,on?0.95:0.7); ctx.shadowColor=hexA(col,0.4); ctx.shadowBlur=on?14:6;
        roundRect(ctx, x-bw/2, Math.min(y,yz), bw, Math.max(Math.abs(y-yz),1.5), 3); ctx.fill(); ctx.shadowBlur=0; });
    };
    hoverBars(cvs, tip, ()=>data, 60, 16, (d)=> d.pct==null?null:
      `<div class="rp-tip-h">${esc(d.label)} · ${ly} vs ${py}</div>
       <div class="rp-tip-v ${d.pct>=0?'pos':'neg'}">${d.pct>=0?'+':''}${d.pct.toFixed(1)}%</div>
       <div class="rp-tip-sub">${fmt0(d.cur)} vs ${fmt0(d.prev)} kWh</div>`,
      (hh)=>{hover=hh; cvs.redraw();}, 12);
    return ()=>cvs.destroy();
  }

  // ── chart 3: this year vs last year (overlaid line chart + legend) ───────────
  function yearLines(host, monthly, years) {
    const cvs = makeCanvas(host, 2.9, 210, 320);
    const tip = mkTip(host);
    let hover = -1;
    const ly = years[years.length-1];
    const py = years.length>=2 ? years[years.length-2] : null;
    const lyA = MON3.map((_,i)=>{ const m=(monthly[String(ly)]||[]).find(p=>p.month===i+1); return m?m.kwh:null; });
    const pyA = py!=null ? MON3.map((_,i)=>{ const m=(monthly[String(py)]||[]).find(p=>p.month===i+1); return m?m.kwh:null; }) : null;
    cvs.draw = (ctx,w,h) => {
      const all = lyA.concat(pyA||[]).filter(v=>v!=null);
      if(!all.length){ emptyMsg(ctx,w,h,"No monthly production logged yet."); return; }
      const ymax = niceMax(Math.max(...all)*1.12)||1;
      const g = frame(ctx,w,h,{ yTitle:"kWh", xTitle:"Month", yMax:ymax, ticks:4, n:12,
        xLabels:(i)=>MON3[i].slice(0,1) });
      const px=(i)=>g.x0 + g.plotW*i/11;
      const drawLine=(arr,col,fill)=>{ const segs=[]; arr.forEach((v,i)=>{ if(v==null){segs.push(null);return;} segs.push([px(i), g.yToPx(v)]); });
        // line
        ctx.strokeStyle=col; ctx.lineWidth=2.5; ctx.lineJoin="round"; ctx.beginPath(); let started=false;
        segs.forEach(s=>{ if(!s){started=false;return;} if(!started){ctx.moveTo(s[0],s[1]);started=true;} else ctx.lineTo(s[0],s[1]); }); ctx.stroke();
        if(fill){ const grd=ctx.createLinearGradient(0,g.y0,0,g.y0+g.plotH); grd.addColorStop(0,hexA(col,0.20)); grd.addColorStop(1,hexA(col,0));
          ctx.fillStyle=grd; ctx.beginPath(); started=false; let first=null,last=null;
          segs.forEach(s=>{ if(!s){return;} if(!started){ctx.moveTo(s[0],g.y0+g.plotH);ctx.lineTo(s[0],s[1]);started=true;first=s;} else ctx.lineTo(s[0],s[1]); last=s; });
          if(first&&last){ ctx.lineTo(last[0],g.y0+g.plotH); ctx.closePath(); ctx.fill(); } }
        // dots
        segs.forEach((s,i)=>{ if(!s) return; ctx.fillStyle=col; ctx.beginPath(); ctx.arc(s[0],s[1], i===hover?4.5:3, 0, 7); ctx.fill(); }); };
      if(pyA) drawLine(pyA, FAINT(), false);     // last year — muted, behind
      drawLine(lyA, GOOD(), true);               // this year — bold green, filled
      // hover guideline
      if(hover>=0){ const x=px(hover); ctx.strokeStyle=GRID; ctx.lineWidth=1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(x,g.y0); ctx.lineTo(x,g.y0+g.plotH); ctx.stroke(); ctx.setLineDash([]); }
    };
    // hover by nearest month
    cvs.cv.style.cursor="crosshair";
    cvs.cv.addEventListener("mousemove",(ev)=>{ const r=cvs.cv.getBoundingClientRect(); const x=ev.clientX-r.left;
      const padL=60,padR=16; const pw=cvs.w-padL-padR; const i=Math.round((x-padL)/(pw/11));
      if(i>=0&&i<12){ if(i!==hover){hover=i; cvs.redraw();}
        const a=lyA[i], b=pyA?pyA[i]:null; if(a==null&&b==null){ tip.style.display="none"; return; }
        let html=`<div class="rp-tip-h">${MON3[i]}</div><div class="rp-tip-row"><span class="rp-sw" style="background:${GOOD()}"></span>${ly}: <b>${a==null?'—':fmt0(a)+' kWh'}</b></div>`;
        if(pyA) html+=`<div class="rp-tip-row"><span class="rp-sw" style="background:${FAINT()}"></span>${py}: <b>${b==null?'—':fmt0(b)+' kWh'}</b></div>`;
        if(a!=null&&b!=null&&b>0){ const dl=100*(a-b)/b; html+=`<div class="rp-tip-sub ${dl>=0?'pos':'neg'}">${dl>=0?'+':''}${dl.toFixed(0)}% vs ${py}</div>`; }
        tip.innerHTML=html; tip.style.display="block"; const tx=Math.min(Math.max(x,70),cvs.w-70); tip.style.left=tx+"px"; tip.style.top="6px";
      } else if(hover!==-1){ hover=-1; cvs.redraw(); tip.style.display="none"; } });
    cvs.cv.addEventListener("mouseleave",()=>{ if(hover!==-1){hover=-1;cvs.redraw();} tip.style.display="none"; });
    return ()=>cvs.destroy();
  }

  // ── shared helpers ───────────────────────────────────────────────────────────
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function mkTip(host){ host.style.position="relative"; const t=document.createElement("div"); t.className="rp-tip"; t.style.display="none"; host.appendChild(t); return t; }
  function emptyMsg(ctx,w,h,msg){ ctx.fillStyle=FAINT(); ctx.font="13px "+FONT; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(msg, w/2, h/2); }
  function needYears(cvs, msg){ cvs.draw=(ctx,w,h)=>emptyMsg(ctx,w,h,msg); }
  function hoverBars(cvs, tip, getData, padL, padR, tipHtml, setHover, fixedN){
    cvs.cv.style.cursor="crosshair";
    cvs.cv.addEventListener("mousemove",(ev)=>{ const data=getData(); const n=fixedN||data.length||1;
      const r=cvs.cv.getBoundingClientRect(); const x=ev.clientX-r.left; const pw=cvs.w-padL-padR; const slot=pw/n;
      const i=Math.floor((x-padL)/slot);
      if(i>=0&&i<n){ const html=tipHtml(data[i]); if(html==null){ tip.style.display="none"; setHover(-1); return; }
        setHover(i); tip.innerHTML=html; tip.style.display="block";
        const tx=Math.min(Math.max(x,72),cvs.w-72); tip.style.left=tx+"px"; tip.style.top="6px";
      } else { setHover(-1); tip.style.display="none"; } });
    cvs.cv.addEventListener("mouseleave",()=>{ setHover(-1); tip.style.display="none"; });
  }

  // ── mount ────────────────────────────────────────────────────────────────────
  function mount(host, payload, core) {
    const monthly = payload.monthly_by_year || {};
    const years = (payload.years||[]).slice().sort((a,b)=>a-b);
    const daily = payload.daily_series && payload.daily_series.length ? payload.daily_series : (payload.daily_recent||[]);
    const ly = years.length?years[years.length-1]:null, py = years.length>=2?years[years.length-2]:null;

    const el = document.createElement("div");
    el.className = "rp-wrap";
    el.innerHTML = `
      <div class="rp-card">
        <div class="rp-card-h"><h3 class="rp-card-t">Daily output</h3>
          <span class="rp-card-sub">Energy produced each day — last ${Math.min((daily||[]).length,31)} days</span></div>
        <div class="rp-chart" id="rpDaily"></div>
      </div>
      <div class="rp-card">
        <div class="rp-card-h"><h3 class="rp-card-t">Year-over-year growth</h3>
          <span class="rp-card-sub">${py!=null?`Each month of ${ly} vs ${py}`:"Appears with a second year of history"}</span></div>
        <div class="rp-chart" id="rpYoY"></div>
      </div>
      <div class="rp-card">
        <div class="rp-card-h"><h3 class="rp-card-t">This year vs last year</h3>
          <span class="rp-card-sub">Monthly production, ${ly}${py!=null?` vs ${py}`:""}</span>
          <div class="rp-legend">
            <span class="rp-leg"><span class="rp-sw" style="background:${GOOD()}"></span>${ly||"This year"}</span>
            ${py!=null?`<span class="rp-leg"><span class="rp-sw" style="background:${FAINT()}"></span>${py}</span>`:""}
          </div></div>
        <div class="rp-chart" id="rpLines"></div>
      </div>`;
    host.appendChild(el);

    const stops = [];
    stops.push(dailyBar(el.querySelector("#rpDaily"), daily));
    stops.push(yoyGrowth(el.querySelector("#rpYoY"), monthly, years));
    stops.push(yearLines(el.querySelector("#rpLines"), monthly, years));

    return function stop(){ stops.forEach(s=>{ try{ s&&s(); }catch(e){} }); try{ el.remove(); }catch(e){} };
  }

  window.AOReport = { mount };
})();
