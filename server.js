const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const app     = express();
const PORT    = process.env.PORT || 3001;

// ── CORS: allow everything (fixes browser fetch errors) ───────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Cache (30s) ───────────────────────────────────────────────
const cache = {};
const gc = (k) => { const e = cache[k]; return e && Date.now()-e.ts < 30000 ? e.d : null; };
const sc = (k,d) => { cache[k] = {d, ts:Date.now()}; return d; };

// ── NSE session cookies ───────────────────────────────────────
let cookies = "";
const H = {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
  "Accept":"application/json, text/plain, */*",
  "Accept-Language":"en-US,en;q=0.9",
  "Referer":"https://www.nseindia.com/",
};

async function prime() {
  try {
    const r1 = await axios.get("https://www.nseindia.com/", { headers:H, timeout:10000 });
    const c1 = (r1.headers["set-cookie"]||[]).map(c=>c.split(";")[0]);
    const r2 = await axios.get("https://www.nseindia.com/market-data/live-equity-market", {
      headers:{...H, Cookie:c1.join("; ")}, timeout:10000
    });
    const c2 = (r2.headers["set-cookie"]||[]).map(c=>c.split(";")[0]);
    cookies = [...new Set([...c1,...c2])].join("; ");
    console.log("NSE primed OK");
  } catch(e) { console.error("NSE prime failed:", e.message); }
}

prime();
setInterval(prime, 4*60*1000);

async function nse(path) {
  const r = await axios.get("https://www.nseindia.com"+path, {
    headers:{...H, Cookie:cookies}, timeout:12000
  });
  return r.data;
}

async function yahoo(symbol) {
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers:{"User-Agent":"Mozilla/5.0"}, timeout:8000 }
    );
    const m = r.data?.chart?.result?.[0]?.meta || {};
    const price = m.regularMarketPrice || 0;
    const prev  = m.chartPreviousClose || m.previousClose || price;
    return { price:+price.toFixed(2), changePct:+(prev?((price-prev)/prev*100):0).toFixed(2), prevClose:+prev.toFixed(2) };
  } catch { return {price:0,changePct:0,prevClose:0}; }
}

// ── /api/all — single endpoint used by the artifact ──────────
app.get("/api/all", async (req, res) => {
  const cached = gc("all");
  if (cached) return res.json(cached);

  const safe = async (fn) => { try { return await fn(); } catch(e) { return {error:e.message}; } };

  const [A,B,C,D] = await Promise.all([

    // 1. NSE indices
    safe(async () => {
      const d = await nse("/api/allIndices");
      const f = (sym) => (d?.data||[]).find(i=>i.indexSymbol===sym)||{};
      const n=f("NIFTY 50"),v=f("INDIA VIX"),b=f("NIFTY BANK"),
            mid=f("NIFTY MIDCAP 100"),sm=f("NIFTY SMALLCAP 100"),
            it=f("NIFTY IT"),psu=f("NIFTY PSU BANK"),
            fin=f("NIFTY FIN SERVICE"),auto=f("NIFTY AUTO");
      return {
        nifty:    {price:n.last||0,change:n.change||0,changePct:n.percentChange||0,high:n.high||0,low:n.low||0,open:n.open||0,prevClose:n.previousClose||0},
        bankNifty:{price:b.last||0,changePct:b.percentChange||0},
        midcap:   {price:mid.last||0,changePct:mid.percentChange||0},
        smallcap: {price:sm.last||0,changePct:sm.percentChange||0},
        sectors:  {it:{price:it.last||0,changePct:it.percentChange||0},psu:{price:psu.last||0,changePct:psu.percentChange||0},fin:{price:fin.last||0,changePct:fin.percentChange||0},auto:{price:auto.last||0,changePct:auto.percentChange||0}},
        vix:      {value:v.last||0,change:v.change||0,prevClose:v.previousClose||0,trend:(v.change||0)<0?"falling":"rising"},
      };
    }),

    // 2. NSE option chain
    safe(async () => {
      const d = await nse("/api/option-chain-indices?symbol=NIFTY");
      const recs=d?.records?.data||[], exps=d?.records?.expiryDates||[];
      const spot=d?.records?.underlyingValue||0;
      const weekly=exps[0]||"";
      const monthly=exps.find(x=>new Date(x).getDate()>=24)||exps[exps.length-1]||"";
      const near=recs.filter(r=>r.expiryDate===weekly);
      const CE=[],PE=[]; let tC=0,tP=0;
      near.forEach(r=>{
        if(r.CE){CE.push({strike:r.strikePrice,oi:r.CE.openInterest||0,chg:r.CE.changeinOpenInterest||0,ltp:r.CE.lastPrice||0,iv:r.CE.impliedVolatility||0});tC+=r.CE.openInterest||0;}
        if(r.PE){PE.push({strike:r.strikePrice,oi:r.PE.openInterest||0,chg:r.PE.changeinOpenInterest||0,ltp:r.PE.lastPrice||0,iv:r.PE.impliedVolatility||0});tP+=r.PE.openInterest||0;}
      });
      const pcr=tC?+(tP/tC).toFixed(2):0;
      const atm=Math.round(spot/50)*50;
      const stks=[...new Set(near.map(r=>r.strikePrice))];
      let mp=0,minP=Infinity;
      stks.forEach(s=>{let p=0;CE.forEach(c=>{if(s>c.strike)p+=(s-c.strike)*c.oi;});PE.forEach(p2=>{if(s<p2.strike)p+=(p2.strike-s)*p2.oi;});if(p<minP){minP=p;mp=s;}});
      const aC=CE.find(c=>c.strike===atm)||CE.find(c=>c.strike===atm+50)||{};
      const aP=PE.find(p=>p.strike===atm)||PE.find(p=>p.strike===atm-50)||{};
      const o1C=CE.find(c=>c.strike===atm+50)||{};
      const o1P=PE.find(p=>p.strike===atm-50)||{};
      return {spot,weeklyExpiry:weekly,monthlyExpiry:monthly,pcr,maxPain:mp,totalCallOI:tC,totalPutOI:tP,
        topCallOI:[...CE].sort((a,b)=>b.oi-a.oi).slice(0,6),
        topPutOI:[...PE].sort((a,b)=>b.oi-a.oi).slice(0,6),
        atmStrike:atm,
        atmCE_ltp:aC.ltp||0,atmCE_iv:aC.iv||0,
        atmPE_ltp:aP.ltp||0,atmPE_iv:aP.iv||0,
        otm1CE_ltp:o1C.ltp||0,otm1PE_ltp:o1P.ltp||0,
        expiries:exps.slice(0,5)};
    }),

    // 3. Yahoo Finance global
    safe(async () => {
      const [dji,spx,nas,n225,hsi,cl,dxy,gold] = await Promise.all([
        yahoo("^DJI"),yahoo("^GSPC"),yahoo("^IXIC"),
        yahoo("^N225"),yahoo("^HSI"),
        yahoo("CL=F"),yahoo("DX-Y.NYB"),yahoo("GC=F"),
      ]);
      return {dji,spx,nas,nikkei:n225,hangseng:hsi,crude:cl,dxy,gold};
    }),

    // 4. NSE FII/DII
    safe(async () => {
      const d = await nse("/api/fiidiidata?type=cash");
      const t = Array.isArray(d)?d[0]:{};
      return {fii:t.fiinet||t.fiiNet||0, dii:t.diinet||t.diiNet||0, date:t.date||""};
    }),
  ]);

  const result = {
    nifty:       A?.nifty||null,
    bankNifty:   A?.bankNifty||null,
    midcap:      A?.midcap||null,
    smallcap:    A?.smallcap||null,
    sectors:     A?.sectors||null,
    vix:         A?.vix||null,
    optionchain: B?.error ? null : B,
    global:      C?.error ? null : C,
    fiidii:      D?.error ? null : D,
    errors:      [A,B,C,D].filter(x=>x?.error).map(x=>x.error),
    fetchedAt:   new Date().toISOString(),
  };
  sc("all", result);
  res.json(result);
});

// health check
app.get("/", (req, res) => res.json({
  status:"NIFTY backend running",
  cookiesLoaded:cookies.length>10,
  time:new Date().toISOString()
}));

app.listen(PORT, () => console.log("Running on port", PORT));
