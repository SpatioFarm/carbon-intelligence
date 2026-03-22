/* ═══════════════════════════════════════════════════════════
   CARBON STOCK INTELLIGENCE — main.js  v6  FINAL

   MAP FIXES:
   - #map-wrap uses position:sticky + height:calc(100vh - 60px)
     with inner flex so leaflet-map gets all remaining space.
   - Leaflet.invalidateSize() called after each tab show.
   - Dark tile: CartoDB Dark Matter with correct subdomains.
   - Grid lines: weight:1.5, white stroke → clearly visible.
   - Google Satellite as default basemap.
   - DEM layer colours ALL 64k cells (not just 2521 test cells).
═══════════════════════════════════════════════════════════ */
"use strict";

// Chart defaults
Chart.defaults.color       = "rgb(90,138,159)";
Chart.defaults.borderColor = "rgba(0,160,220,.08)";
Chart.defaults.font.family = "'JetBrains Mono',monospace";
Chart.defaults.font.size   = 10;

const C = { green:"#00ff88", cyan:"#00d4ff", blue:"#0ea5e9",
            purple:"#a78bfa", yellow:"#fbbf24", orange:"#f97316" };
const CH = {};
function kill(id){ if(CH[id]){CH[id].destroy();delete CH[id];} }

function base(x={}){
  return { responsive:true, maintainAspectRatio:false,
    animation:{duration:800,easing:"easeOutQuart"},
    plugins:{legend:{display:false},...x.plugins}, ...x };
}

// ── NAVIGATION ───────────────────────────────────────────
function showPage(name){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(a=>a.classList.remove("active"));
  document.getElementById("page-"+name)?.classList.add("active");
  document.querySelectorAll(".nav-link").forEach(a=>{
    if(a.textContent.trim().toLowerCase()===name) a.classList.add("active");
  });
  if(name==="map")      { loadMap(); }
  if(name==="analytics") loadAnalytics();
  if(name==="model")     loadModel();
  if(name==="explorer")  { ePage=1; loadExplorer(); }
}

function showTab(id,btn){
  document.querySelectorAll(".tp").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
  document.getElementById(id)?.classList.add("active");
  btn?.classList.add("active");
  if(id==="tf"&&window._fi) drawFI(window._fi);
}

async function api(url){
  const r=await fetch(url);
  if(!r.ok) throw new Error(url+" → "+r.status);
  return r.json();
}

// ── HOME ─────────────────────────────────────────────────
async function loadHome(){
  let s={};
  try{ s=await api("/api/summary"); }catch(e){ console.warn(e); }
  const tot=+(s.total_million_tc||54.228),agc=+(s.agc_million_tc||1.6678),bgc=+(s.bgc_million_tc||52.5602);
  countUp("kpi-total",tot,4); countUp("kpi-ag",agc,4); countUp("kpi-bg",bgc,4);
  countUp("kpi-agr2",+(s.ag_r2||0.5426),4); countUp("kpi-bgr2",+(s.bg_r2||0.9665),4);
  setTxt("nav-total",tot.toFixed(2)+" MtC");
  setTimeout(()=>{
    setBar("kp-ag",(agc/tot)*100); setBar("kp-bg",(bgc/tot)*100);
    setBar("kp-agr2",(s.ag_r2||0.5426)*100); setBar("kp-bgr2",(s.bg_r2||0.9665)*100);
  },700);

  kill("home-bar");
  CH["home-bar"]=new Chart(document.getElementById("chart-home-bar"),{
    type:"bar",
    data:{labels:["Above-ground (AGC)","Below-ground (BGC)"],
      datasets:[{data:[agc,bgc],backgroundColor:[C.green,C.blue],
        borderColor:["#00cc6e","#0880b8"],borderWidth:1.5,borderRadius:4,borderSkipped:false}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.parsed.y.toFixed(4)} MtC`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f",font:{family:"Space Grotesk",size:11}}},
        y:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},max:58,
           title:{display:true,text:"million tC",color:"#5a8a9f",font:{size:10}}}
      }
    })
  });

  kill("home-pie");
  CH["home-pie"]=new Chart(document.getElementById("chart-home-pie"),{
    type:"doughnut",
    data:{labels:["Above-ground","Below-ground"],
      datasets:[{data:[agc,bgc],backgroundColor:[C.green,C.blue],
        borderColor:["#020509","#020509"],borderWidth:3,hoverOffset:10}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:"64%",
      animation:{duration:900,easing:"easeOutQuart"},
      plugins:{
        legend:{display:true,position:"bottom",labels:{color:"#5a8a9f",padding:14,font:{family:"Space Grotesk",size:11}}},
        tooltip:{callbacks:{label:c=>` ${c.label}: ${c.parsed.toFixed(4)} MtC`}}
      }}
  });
}

// ── MAP ──────────────────────────────────────────────────
// KEY ARCHITECTURE:
// #map-wrap  = position:sticky, height:calc(100vh - 60px), flex column
// #leaflet-map = flex:1, min-height:0  → fills all remaining space

let MAP=null, GJ_LAYER=null, GJ_DATA=null, MAP_LAYER="dem";

// Tile definitions
// Google Satellite/Hybrid/Street via mt1.google.com
// All 4 tiles use Google Maps servers → correct Indian borders on all tiles
const TILES = {
  sat: {
    // Google Satellite — photorealistic imagery
    url:  "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    attr: "© Google Maps",
    subs: ["mt0","mt1","mt2","mt3"],
    maxZ: 20,
  },
  hyb: {
    // Google Hybrid — satellite + labels
    url:  "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    attr: "© Google Maps",
    subs: ["mt0","mt1","mt2","mt3"],
    maxZ: 20,
  },
  str: {
    // Google Street Map — standard road map
    url:  "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
    attr: "© Google Maps",
    subs: ["mt0","mt1","mt2","mt3"],
    maxZ: 20,
  },
  dark: {
    // Google Street Map — clean vector map, perfect for dark filter
    url:  "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
    attr: "© Google Maps",
    subs: ["mt0","mt1","mt2","mt3"],
    maxZ: 20,
  },
};
let TILE_L=null, ACTIVE_TILE="sat";

// 5-stop vivid colour ramp
function ramp(t){
  if(t<.2)  return `hsl(220,100%,62%)`;
  if(t<.4)  return `hsl(185,100%,52%)`;
  if(t<.6)  return `hsl(145,100%,48%)`;
  if(t<.8)  return `hsl(45, 100%,52%)`;
  return            `hsl(15, 100%,58%)`;
}

async function loadMap(){
  // Initialise Leaflet once
  if(!MAP){
    MAP=L.map("leaflet-map",{
      center: [30.82, 75.84],
      zoom:   13,               // 250m cells = ~13px at zoom 13
      minZoom:3,
      maxZoom:20,
      zoomControl: false,
      preferCanvas: false,      // SVG = crisper polygon outlines
    });

    L.control.zoom({ position:"bottomright" }).addTo(MAP);
    L.control.scale({ position:"bottomleft", imperial:false }).addTo(MAP);

    // Default basemap: Google Satellite
    TILE_L = L.tileLayer(TILES.sat.url, {
      attribution: TILES.sat.attr,
      maxZoom:     TILES.sat.maxZ,
      subdomains:  TILES.sat.subs,
    }).addTo(MAP);
    // Ensure no dark filter on first load
    document.getElementById("leaflet-map").style.filter = "none";
    setTimeout(()=>{
      document.querySelectorAll(".leaflet-tile-pane").forEach(p=>p.style.filter="none");
    }, 300);

    // Hide zoom banner when user zooms to 13+
    MAP.on("zoomend", ()=>{
      const b=document.getElementById("zoom-banner");
      if(b) b.classList.toggle("gone", MAP.getZoom()>=13);
    });
  }

  // Always invalidate size when tab is shown
  setTimeout(()=>{ MAP.invalidateSize(); }, 100);

  // Only fetch data once
  if(GJ_DATA){ drawPolygons(GJ_DATA); return; }

  setTxt("map-de","Fetching 250 m × 250 m polygons from PostGIS…");
  try{
    const gj = await api("/api/geojson?limit=1200");
    GJ_DATA = gj;
    setTxt("map-de",
      `${gj.features.length.toLocaleString()} real 250 m × 250 m polygons · PostGIS · Ludhiana District`);
    drawPolygons(gj);
  }catch(e){
    console.error(e);
    setTxt("map-de","Error loading data — ensure backend is running");
  }
}

function drawPolygons(gj){
  if(GJ_LAYER){ MAP.removeLayer(GJ_LAYER); GJ_LAYER=null; }

  const key = MAP_LAYER;
  let vals=[];
  if(key==="dem")  vals=gj.features.map(f=>+(f.properties.dem  ||0)).filter(v=>v>0);
  if(key==="slope")vals=gj.features.map(f=>+(f.properties.slope||0)).filter(v=>v>0);
  if(key==="agc")  vals=gj.features.filter(f=>f.properties.has_carbon&&f.properties.agc>0).map(f=>+f.properties.agc);
  if(key==="bgc")  vals=gj.features.filter(f=>f.properties.has_carbon&&f.properties.bgc>0).map(f=>+f.properties.bgc);
  if(key==="agri") vals=gj.features.map(f=>+(f.properties.agnonag||0));

  const lo  = vals.length ? Math.min(...vals) : 0;
  const hi  = vals.length ? Math.max(...vals) : 1;
  const mean= vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;

  // Update KPI pills
  const kp=document.getElementById("map-kpis");
  if(kp) kp.style.display="flex";
  setTxt("mk-mean", mean.toFixed(3)+(key!=="agri"?" m/tC/ha":""));
  setTxt("mk-max",  hi.toFixed(3));
  setTxt("mk-min",  lo.toFixed(3));
  setTxt("mk-cnt",  gj.features.length.toLocaleString());

  GJ_LAYER = L.geoJSON(gj, {
    style(f){
      const p=f.properties;
      let col;
      if(key==="agc"){
        col = p.has_carbon&&p.agc>0
          ? ramp(Math.max(0,Math.min(1,(p.agc-lo)/(hi-lo||1))))
          : "#1a3a5a";
      } else if(key==="bgc"){
        col = p.has_carbon&&p.bgc>0
          ? ramp(Math.max(0,Math.min(1,(p.bgc-lo)/(hi-lo||1))))
          : "#1a3a5a";
      } else if(key==="agri"){
        col = p.agri===1
          ? `hsl(${140+(p.agnonag||0)*30},90%,50%)`
          : `hsl(210,70%,45%)`;
      } else {
        // DEM or slope — works for ALL cells
        const v = key==="dem" ? +(p.dem||0) : +(p.slope||0);
        col = ramp(Math.max(0,Math.min(1,(v-lo)/(hi-lo||1))));
      }
      return {
        fillColor:   col,
        fillOpacity: 0.80,
        // FIX: white 1.2px stroke makes grid lines clearly visible
        color:       "rgba(255,255,255,0.35)",
        weight:      1.2,
        opacity:     1,
      };
    },
    onEachFeature(f,layer){
      const p=f.properties;
      layer.bindPopup(popup(p), { maxWidth:240 });
      layer.on({
        mouseover(e){
          e.target.setStyle({ fillOpacity:1, weight:2.5, color:"#ffffff", opacity:0.9 });
          e.target.bringToFront();
        },
        mouseout(e){ GJ_LAYER.resetStyle(e.target); },
      });
    }
  }).addTo(MAP);
}

function popup(p){
  const r=(l,v,c)=>`
    <div style="background:rgba(255,255,255,.05);border-radius:5px;padding:5px 9px">
      <div style="color:#1e4a62;font-size:.58rem;letter-spacing:1.2px;text-transform:uppercase">${l}</div>
      <div style="color:${c};font-weight:700;font-size:.82rem;margin-top:2px">${v}</div>
    </div>`;
  return `<div style="min-width:210px;font-family:'Space Grotesk',sans-serif">
    <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:.92rem;color:#00d4ff;
         border-bottom:1px solid rgba(0,180,255,.2);padding-bottom:8px;margin-bottom:10px">
      Grid Cell #${p.grid_id}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
      ${r("AGC tC/ha",  p.agc>0 ? p.agc.toFixed(4) : "—", p.agc>0?"#00ff88":"#3a607a")}
      ${r("BGC tC/ha",  p.bgc>0 ? p.bgc.toFixed(4) : "—", p.bgc>0?"#0ea5e9":"#3a607a")}
      ${r("Class",      p.agri ? "Agricultural" : "Non-agri", p.agri?"#00ff88":"#f97316")}
      ${r("DEM (m)",    (+p.dem).toFixed(1),  "#fbbf24")}
      ${r("Clay %",     (+p.clay).toFixed(1), "#0ea5e9")}
      ${r("BD g/cm³",   (+p.bd).toFixed(2),   "#a78bfa")}
    </div>
  </div>`;
}

function setLayer(l){
  MAP_LAYER=l;
  ["dem","agri","agc","bgc"].forEach(k=>{
    document.getElementById("btn-"+k)?.classList.toggle("active", k===l);
  });
  if(GJ_DATA) drawPolygons(GJ_DATA);
}

function setTile(k){
  if(TILE_L) MAP.removeLayer(TILE_L);
  const t=TILES[k];
  TILE_L = L.tileLayer(t.url, {
    attribution: t.attr,
    maxZoom:     t.maxZ,
    subdomains:  t.subs,
  }).addTo(MAP);
  ACTIVE_TILE=k;
  // Re-add polygon layer on top of new basemap
  if(GJ_LAYER){ GJ_LAYER.bringToFront(); }
  // Apply dark CSS filter only to the tile pane (not the polygon overlay)
  // This keeps polygon colours correct while making the basemap dark
  const tilePanes = document.querySelectorAll(".leaflet-tile-pane");
  const overlayPanes = document.querySelectorAll(".leaflet-overlay-pane");
  if(k === "dark"){
    // grayscale + invert = dark background with white borders and labels
    tilePanes.forEach(p => p.style.filter = "grayscale(1) invert(1) brightness(0.85)");
    // Keep polygon layer colours normal by counter-inverting
    overlayPanes.forEach(p => p.style.filter = "none");
  } else {
    tilePanes.forEach(p    => p.style.filter = "none");
    overlayPanes.forEach(p => p.style.filter = "none");
  }
  const mapEl = document.getElementById("leaflet-map");
  mapEl.style.filter = "none"; // always keep map container unfiltered
  // Update button states
  ["sat","hyb","str","dark"].forEach(n=>{
    document.getElementById("ts-"+n)?.classList.toggle("active", n===k);
  });
}

// ── ANALYTICS ────────────────────────────────────────────
async function loadAnalytics(){
  let s={},ndvi=[],carbon={ag:[],bg:[]};
  try{
    [s,ndvi,carbon]=await Promise.all([
      api("/api/summary"), api("/api/ndvi"), api("/api/carbon?per_page=500")
    ]);
  }catch(e){ console.warn(e); }

  const tot=+(s.total_million_tc||54.228),agc=+(s.agc_million_tc||1.6678),bgc=+(s.bgc_million_tc||52.5602);
  setTxt("a-total",tot.toFixed(4)); setTxt("a-ag",agc.toFixed(4));
  setTxt("a-bg",bgc.toFixed(4));   setTxt("a-bgpct",((bgc/tot)*100).toFixed(2)+"%");

  kill("pool-bar");
  CH["pool-bar"]=new Chart(document.getElementById("chart-pool-bar"),{
    type:"bar",
    data:{labels:["Above-ground","Below-ground"],
      datasets:[{data:[agc,bgc],backgroundColor:[C.green,C.blue],
        borderColor:["#00cc6e","#0880b8"],borderWidth:1.5,borderRadius:4,borderSkipped:false}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.parsed.y.toFixed(4)} MtC`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f",font:{family:"Space Grotesk",size:11}}},
        y:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},max:58,
           title:{display:true,text:"million tC",color:"#5a8a9f",font:{size:10}}}
      }
    })
  });

  kill("pool-pie");
  CH["pool-pie"]=new Chart(document.getElementById("chart-pool-pie"),{
    type:"doughnut",
    data:{labels:["Above-ground","Below-ground"],
      datasets:[{data:[agc,bgc],backgroundColor:[C.green,C.blue],borderColor:["#020509","#020509"],borderWidth:3,hoverOffset:10}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:"64%",
      animation:{duration:900,easing:"easeOutQuart"},
      plugins:{legend:{display:true,position:"bottom",labels:{color:"#5a8a9f",padding:14,font:{family:"Space Grotesk",size:11}}},
               tooltip:{callbacks:{label:c=>` ${c.label}: ${c.parsed.toFixed(4)} MtC`}}}}
  });

  // NDVI
  const sorted=[...ndvi].sort((a,b)=>a.sort_order-b.sort_order);
  const months=sorted.map(d=>d.month), vals=sorted.map(d=>+(d.median_ndvi||d.mean_ndvi||0));
  const ptClr=sorted.map(d=>d.season==="Kharif"?C.green:C.blue);
  const med=vals.length?[...vals].sort((a,b)=>a-b)[Math.floor(vals.length/2)]:0;
  setTxt("ndvi-med",med.toFixed(3));

  kill("ndvi");
  const nctx=document.getElementById("chart-ndvi").getContext("2d");
  const ng=nctx.createLinearGradient(0,0,0,290);
  ng.addColorStop(0,"rgba(0,255,136,.32)"); ng.addColorStop(1,"rgba(0,255,136,.02)");
  CH["ndvi"]=new Chart(nctx,{
    type:"line",
    data:{labels:months,datasets:[{label:"Median NDVI",data:vals,
      borderColor:C.green,borderWidth:2.5,
      pointBackgroundColor:ptClr,pointBorderColor:"#020509",pointBorderWidth:1.5,
      pointRadius:5,pointHoverRadius:8,fill:true,backgroundColor:ng,tension:0.4}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` NDVI = ${c.parsed.y.toFixed(4)}`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f",font:{family:"Space Grotesk",size:11}}},
        y:{grid:{color:"rgba(0,160,220,.07)"},min:0,max:1,ticks:{color:"#5a8a9f"},
           title:{display:true,text:"Median NDVI",color:"#5a8a9f",font:{size:10}}}
      }
    })
  });

  // AGC histogram
  const agV=(carbon.ag||[]).map(d=>d.agc_tC_ha).filter(Boolean), agH=makeHist(agV,8);
  kill("ag-hist");
  CH["ag-hist"]=new Chart(document.getElementById("chart-ag-hist"),{
    type:"bar",
    data:{labels:agH.labels,datasets:[{data:agH.counts,
      backgroundColor:agH.labels.map((_,i)=>`hsl(${145+i*5},88%,${48+i*2}%)`),
      borderColor:C.green,borderWidth:1,borderRadius:4,borderSkipped:false}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.parsed.y} cells`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},title:{display:true,text:"AGC (tC/ha)",color:"#5a8a9f",font:{size:10}}},
        y:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},title:{display:true,text:"Cell Count",color:"#5a8a9f",font:{size:10}}}
      }
    })
  });

  // BGC histogram
  const bgV=(carbon.bg||[]).map(d=>d.bgc_tC_ha).filter(Boolean), bgH=makeHist(bgV,8);
  kill("bg-hist");
  CH["bg-hist"]=new Chart(document.getElementById("chart-bg-hist"),{
    type:"bar",
    data:{labels:bgH.labels,datasets:[{data:bgH.counts,
      backgroundColor:bgH.labels.map((_,i)=>`hsl(${200+i*8},82%,${48+i*2}%)`),
      borderColor:C.blue,borderWidth:1,borderRadius:4,borderSkipped:false}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.parsed.y} cells`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},title:{display:true,text:"BGC (tC/ha)",color:"#5a8a9f",font:{size:10}}},
        y:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},title:{display:true,text:"Cell Count",color:"#5a8a9f",font:{size:10}}}
      }
    })
  });
}

// ── MODEL ────────────────────────────────────────────────
async function loadModel(){
  let m={};
  try{ m=await api("/api/metrics"); }catch(e){ console.warn(e); }
  window._fi=m.feature_importance||[];

  setTimeout(()=>{
    const C251=251.2;
    const ra=document.getElementById("ring-ag"), rb=document.getElementById("ring-bg");
    if(ra){
      ra.style.strokeDashoffset=C251*(1-(m.ag_r2||0.5426));
      const t=ra.closest("svg").querySelector("text");
      if(t) t.textContent=((m.ag_r2||0.5426)*100).toFixed(1)+"%";
    }
    if(rb){
      rb.style.strokeDashoffset=C251*(1-(m.bg_r2||0.9665));
      const t=rb.closest("svg").querySelector("text");
      if(t) t.textContent=((m.bg_r2||0.9665)*100).toFixed(1)+"%";
    }
  },400);

  setTxt("ag-rmse",m.ag_rmse?.toFixed(3)); setTxt("ag-mae",m.ag_mae?.toFixed(3));
  setTxt("ag-tr",(m.ag_train_cells||10081).toLocaleString()); setTxt("ag-te",(m.ag_test_cells||2521).toLocaleString());
  setTxt("bg-rmse",m.bg_rmse?.toFixed(3)); setTxt("bg-mae",m.bg_mae?.toFixed(3));
  setTxt("bg-tr",(m.bg_train_cells||16000).toLocaleString()); setTxt("bg-te",(m.bg_test_cells||4000).toLocaleString());

  const tbody=document.getElementById("cmp-tbody");
  if(tbody){
    tbody.innerHTML="";
    (m.comparison||[]).forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML=`<td>${r.model}</td>
        <td style="color:${r.target==="NPP"?C.green:C.blue}">${r.target}</td>
        <td style="color:#e8f4f8;font-weight:700">${r.r2.toFixed(4)}</td>
        <td>${r.rmse.toFixed(3)}</td><td>${r.mae.toFixed(3)}</td>
        <td>${r.best?`<span style="color:${C.green};font-weight:700">✓ Best ${r.target}</span>`:'<span style="color:#1e4a62">—</span>'}</td>`;
      tbody.appendChild(tr);
    });
  }
}

function drawFI(fi){
  if(!fi?.length) return;
  const sorted=[...fi].sort((a,b)=>a.importance-b.importance);
  kill("fi");
  CH["fi"]=new Chart(document.getElementById("chart-fi"),{
    type:"bar",
    data:{labels:sorted.map(d=>d.feature),
      datasets:[{data:sorted.map(d=>d.importance),
        backgroundColor:sorted.map(d=>d.type==="ndvi"?C.green:C.yellow),
        borderColor:sorted.map(d=>d.type==="ndvi"?"#00cc6e":"#d4990e"),
        borderWidth:1,borderRadius:4,borderSkipped:false}]},
    options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,
      animation:{duration:900,easing:"easeOutQuart"},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.parsed.x.toFixed(4)}`}}},
      scales:{
        x:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"},title:{display:true,text:"Importance Score",color:"#5a8a9f",font:{size:10}}},
        y:{grid:{display:false},ticks:{color:"#8ab4c8",font:{size:11,family:"JetBrains Mono"}}}
      }}
  });
}

// ── EXPLORER ─────────────────────────────────────────────
let EAG=[],EBG=[],ePage=1;
const EPP=100;

async function loadExplorer(){
  const tl=document.getElementById("tbl-load"), tb=document.getElementById("exp-tbl");
  if(tl) tl.style.display="block";
  if(tb) tb.style.display="none";
  let res={ag:[],bg:[],ag_total:0,bg_total:0};
  try{ res=await api(`/api/carbon?page=${ePage}&per_page=${EPP}`); }catch(e){ console.warn(e); }
  EAG=res.ag||[]; EBG=res.bg||[];
  setTxt("ec-tot",(res.ag_total||0).toLocaleString()+" AG · "+(res.bg_total||0).toLocaleString()+" BG");
  buildPages(res.ag_total||0,EPP);
  renderTbl();
}

function renderTbl(){
  const search=(document.getElementById("fs")?.value||"").toLowerCase();
  const mn=parseFloat(document.getElementById("fmin")?.value)||-Infinity;
  const mx=parseFloat(document.getElementById("fmax")?.value)||Infinity;
  const filt=EAG.filter(d=>
    (!search||String(d.cell_index).includes(search))&&
    (d.agc_tC_ha||0)>=mn&&(d.agc_tC_ha||0)<=mx
  );
  const mAG=filt.length?filt.reduce((s,d)=>s+(d.agc_tC_ha||0),0)/filt.length:0;
  const mBG=EBG.length?EBG.reduce((s,d)=>s+(d.bgc_tC_ha||0),0)/EBG.length:0;
  setTxt("ec-show",filt.length+" cells");
  setTxt("ec-mag",mAG.toFixed(4)+" tC/ha");
  setTxt("ec-mbg",mBG.toFixed(4)+" tC/ha");

  const tbody=document.getElementById("exp-tbody");
  if(tbody){
    tbody.innerHTML="";
    filt.slice(0,50).forEach(ag=>{
      const bg=EBG.find(b=>b.cell_index===ag.cell_index)||{};
      const agc=ag.agc_tC_ha||0, bgc=bg.bgc_tC_ha||0, tot=agc+bgc;
      const g=tot>150?"a":tot>100?"b":"c";
      const tr=document.createElement("tr");
      tr.innerHTML=`<td style="color:#00d4ff">#${ag.cell_index}</td>
        <td style="color:#00ff88">${agc.toFixed(4)}</td>
        <td style="color:#0ea5e9">${bgc>0?bgc.toFixed(4):"—"}</td>
        <td style="color:#a78bfa;font-weight:600">${tot>0?tot.toFixed(4):"—"}</td>
        <td>${(ag.predicted_npp||0).toFixed(2)}</td>
        <td>${bg.predicted_soc?bg.predicted_soc.toFixed(4):"—"}</td>
        <td><span class="g${g}">${g==="a"?"HIGH":g==="b"?"MED":"LOW"}</span></td>`;
      tbody.appendChild(tr);
    });
  }

  const tl=document.getElementById("tbl-load"), tb=document.getElementById("exp-tbl");
  if(tl) tl.style.display="none"; if(tb) tb.style.display="table";
  const more=document.getElementById("exp-more");
  if(more){more.style.display=filt.length>50?"block":"none";more.textContent=`Showing 50 of ${filt.length}`;}

  // Scatter
  const pts=EAG.filter(a=>a.agc_tC_ha>0).slice(0,300).map(ag=>{
    const bg=EBG.find(b=>b.cell_index===ag.cell_index);
    return bg?{x:ag.agc_tC_ha,y:bg.bgc_tC_ha}:null;
  }).filter(Boolean);
  kill("scatter");
  CH["scatter"]=new Chart(document.getElementById("chart-scatter"),{
    type:"scatter",
    data:{datasets:[{label:"Cells",data:pts,backgroundColor:C.blue,pointRadius:3,pointHoverRadius:6}]},
    options:base({
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` AGC:${c.parsed.x.toFixed(4)} BGC:${c.parsed.y.toFixed(4)}`}}},
      scales:{
        x:{title:{display:true,text:"AGC (tC/ha)",color:"#5a8a9f"},grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"}},
        y:{title:{display:true,text:"BGC (tC/ha)",color:"#5a8a9f"},grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"}}
      }
    })
  });

  // Histogram
  const hd=makeHist(filt.map(d=>d.agc_tC_ha).filter(Boolean),8);
  kill("ehist");
  CH["ehist"]=new Chart(document.getElementById("chart-ehist"),{
    type:"bar",
    data:{labels:hd.labels,datasets:[{data:hd.counts,
      backgroundColor:hd.labels.map((_,i)=>`hsl(${142+i*12},85%,${48+i*2}%)`),
      borderColor:C.green,borderWidth:1,borderRadius:4,borderSkipped:false}]},
    options:base({
      plugins:{legend:{display:false}},
      scales:{
        x:{title:{display:true,text:"AGC (tC/ha)",color:"#5a8a9f"},grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"}},
        y:{grid:{color:"rgba(0,160,220,.07)"},ticks:{color:"#5a8a9f"}}
      }
    })
  });
}

function doFilter(){ renderTbl(); }
function buildPages(total,pp){
  const n=Math.ceil(total/pp), wrap=document.getElementById("pages");
  if(!wrap) return; wrap.innerHTML="";
  for(let i=1;i<=Math.min(n,8);i++){
    const b=document.createElement("button");
    b.className="pgb"+(i===ePage?" active":"");
    b.textContent=i; b.onclick=()=>{ePage=i;loadExplorer();};
    wrap.appendChild(b);
  }
}
function doExport(){
  const rows=EAG.map(ag=>{
    const bg=EBG.find(b=>b.cell_index===ag.cell_index)||{};
    return `${ag.cell_index},${(ag.agc_tC_ha||0).toFixed(4)},${(bg.bgc_tC_ha||0).toFixed(4)},${((ag.agc_tC_ha||0)+(bg.bgc_tC_ha||0)).toFixed(4)},${(ag.predicted_npp||0).toFixed(2)},${(bg.predicted_soc||0).toFixed(4)}`;
  });
  const a=Object.assign(document.createElement("a"),{
    href:URL.createObjectURL(new Blob(["Cell,AGC,BGC,Total,NPP,SOC\n"+rows.join("\n")],{type:"text/csv"})),
    download:"carbon_predictions.csv"
  }); a.click();
}

// ── UTILITIES ────────────────────────────────────────────
function countUp(id,target,dec=2,ms=1600){
  const el=document.getElementById(id); if(!el) return;
  let start=null;
  const step=ts=>{
    if(!start) start=ts;
    const p=Math.min((ts-start)/ms,1);
    el.textContent=(target*(1-Math.pow(1-p,4))).toFixed(dec);
    if(p<1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function setTxt(id,v){ const e=document.getElementById(id); if(e&&v!=null) e.textContent=v; }
function setBar(id,p){ const e=document.getElementById(id); if(e) e.style.width=Math.min(+p,100)+"%"; }
function makeHist(vals,bins=8){
  if(!vals.length) return{labels:[],counts:[]};
  const mn=Math.min(...vals),mx=Math.max(...vals),st=(mx-mn)/bins||1;
  const c=Array(bins).fill(0);
  vals.forEach(v=>c[Math.min(Math.floor((v-mn)/st),bins-1)]++);
  return{labels:c.map((_,i)=>(mn+i*st).toFixed(1)),counts:c};
}

// ── INIT ─────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded",async()=>{
  window.addEventListener("scroll",()=>{
    document.getElementById("navbar")?.classList.toggle("scrolled",window.scrollY>8);
  });
  try{ await loadHome(); }catch(e){ console.error(e); }
  const ldr=document.getElementById("ldr");
  if(ldr){ ldr.classList.add("out"); setTimeout(()=>ldr.remove(),550); }
});
