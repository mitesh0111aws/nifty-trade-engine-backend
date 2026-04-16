// ============================================================
// NIFTY Trade Engine — Backend Server v2 (FIXED)
// Deploy FREE on Render.com
// ============================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Cache (30 sec TTL) ────────────────────────────────────────
const cache = {};
const getCache = (k) => { const e = cache[k]; return e && Date.now() - e.ts < 30000 ? e.data : null; };
const setCache = (k, d) => { cache[k] = { data: d, ts: Date.now() }; };

// ── NSE Browser Headers ───────────────────────────────────────
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin": "https://www.nseindia.com",
  "Referer": "https://www.nseindia.com/market-data/live-equity-market",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Connection": "keep-alive",
  "X-Requested-With": "XMLHttpRequest",
};

// ── NSE Session (cookies must be primed first) ────────────────
let nseCookies = "";
let nseSessionOk = false;

const nseAxios = axios.create({
  baseURL: "https://www.nseindia.com",
  timeout: 12000,
  headers: NSE_HEADERS,
});

async function primeNSE() {
  try {
    // Step 1: hit homepage to get basic cookies
    const r1 = await nseAxios.get("/", { headers: NSE_HEADERS });
    const c1 = r1.headers["set-cookie"] || [];
    
    // Step 2: hit a data page to get session cookie
    const r2 = await nseAxios.get("/market-data/live-equity-market", {
      headers: { ...NSE_HEADERS, Cookie: c1.map(c => c.split(";")[0]).join("; ") }
    });
    const c2 = r2.headers["set-cookie"] || [];
    
    // Merge all cookies
    const allCookies = [...c1, ...c2];
    nseCookies = allCookies.map(c => c.split(";")[0]).join("; ");
    nseSessionOk = true;
    console.log("NSE session primed OK");
  } catch (e) {
    console.error("NSE prime failed:", e.message);
    nseSessionOk = false;
  }
}

// Prime on startup, re-prime every 4 minutes
primeNSE();
setInterval(primeNSE, 4 * 60 * 1000);

// NSE GET helper
async function nseGet(path) {
  if (!nseSessionOk) await primeNSE();
  const r = await nseAxios.get(path, {
    headers: { ...NSE_HEADERS, Cookie: nseCookies }
  });
  return r.data;
}

// Yahoo Finance helper
async function yahooGet(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
      timeout: 8000,
    });
    const meta = r.data?.chart?.result?.[0]?.meta || {};
    const price = meta.regularMarketPrice || 0;
    const prev = meta.chartPreviousClose || meta.previousClose || price;
    const chg = price - prev;
    const chgPct = prev ? ((chg / prev) * 100).toFixed(2) : "0.00";
    return { price: +price.toFixed(2), change: +chg.toFixed(2), changePct: chgPct, prevClose: +prev.toFixed(2) };
  } catch (e) {
    console.error(`Yahoo ${symbol} failed:`, e.message);
    return { price: 0, change: 0, changePct: "0.00", prevClose: 0 };
  }
}

// ══════════════════════════════════════════════════════════════
// ROUTE: Health check
// ══════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "NIFTY Trade Engine Backend v2 running",
    nseSession: nseSessionOk,
    time: new Date().toISOString(),
    routes: ["/api/nifty", "/api/optionchain", "/api/global", "/api/fiidii", "/api/all"]
  });
});

// ══════════════════════════════════════════════════════════════
// ROUTE: NIFTY + VIX
// ══════════════════════════════════════════════════════════════
app.get("/api/nifty", async (req, res) => {
  const cached = getCache("nifty");
  if (cached) return res.json(cached);

  try {
    const data = await nseGet("/api/allIndices");
    const indices = data?.data || [];

    const find = (sym) => indices.find(i => i.indexSymbol === sym) || {};
    const nifty = find("NIFTY 50");
    const vix   = find("INDIA VIX");
    const bank  = find("NIFTY BANK");

    const result = {
      nifty: {
        price:     nifty.last          || nifty.lastPrice || 0,
        change:    nifty.change        || 0,
        changePct: nifty.percentChange || 0,
        high:      nifty.high          || 0,
        low:       nifty.low           || 0,
        open:      nifty.open          || 0,
        prevClose: nifty.previousClose || 0,
      },
      bankNifty: {
        price:     bank.last           || 0,
        changePct: bank.percentChange  || 0,
      },
      vix: {
        value:     vix.last            || 0,
        change:    vix.change          || 0,
        changePct: vix.percentChange   || 0,
        prevClose: vix.previousClose   || 0,
        trend:     (vix.change || 0) < 0 ? "falling" : "rising",
      },
      timestamp: new Date().toISOString(),
    };

    setCache("nifty", result);
    res.json(result);
  } catch (err) {
    console.error("NIFTY route:", err.message);
    // Fallback to Yahoo Finance if NSE fails
    try {
      const yNifty = await yahooGet("^NSEI");
      const yVix   = await yahooGet("^INDIAVIX");
      const result = {
        nifty: {
          price: yNifty.price, change: yNifty.change,
          changePct: yNifty.changePct, high: 0, low: 0,
          open: 0, prevClose: yNifty.prevClose,
        },
        vix: {
          value: yVix.price, change: yVix.change,
          changePct: yVix.changePct, prevClose: yVix.prevClose,
          trend: yVix.change < 0 ? "falling" : "rising",
        },
        source: "yahoo_fallback",
        timestamp: new Date().toISOString(),
      };
      setCache("nifty", result);
      res.json(result);
    } catch (e2) {
      res.status(500).json({ error: err.message, fallbackError: e2.message });
    }
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE: Option Chain (OI, PCR, Max Pain, live premiums)
// ══════════════════════════════════════════════════════════════
app.get("/api/optionchain", async (req, res) => {
  const cached = getCache("optionchain");
  if (cached) return res.json(cached);

  try {
    const data = await nseGet("/api/option-chain-indices?symbol=NIFTY");
    const records   = data?.records?.data        || [];
    const expDates  = data?.records?.expiryDates || [];
    const spot      = data?.records?.underlyingValue || 0;

    const weeklyExpiry  = expDates[0] || "";
    const monthlyExpiry = expDates.find(d => new Date(d).getDate() >= 24) || expDates[expDates.length - 1] || "";

    const nearData = records.filter(r => r.expiryDate === weeklyExpiry);

    const callOI = [], putOI = [];
    let totalCallOI = 0, totalPutOI = 0;

    nearData.forEach(r => {
      if (r.CE) {
        callOI.push({ strike: r.strikePrice, oi: r.CE.openInterest || 0, chgOI: r.CE.changeinOpenInterest || 0, ltp: r.CE.lastPrice || 0, iv: r.CE.impliedVolatility || 0 });
        totalCallOI += r.CE.openInterest || 0;
      }
      if (r.PE) {
        putOI.push({ strike: r.strikePrice, oi: r.PE.openInterest || 0, chgOI: r.PE.changeinOpenInterest || 0, ltp: r.PE.lastPrice || 0, iv: r.PE.impliedVolatility || 0 });
        totalPutOI += r.PE.openInterest || 0;
      }
    });

    const pcr = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(2) : 0;

    // Max pain
    const strikes = [...new Set(nearData.map(r => r.strikePrice))].sort((a,b) => a-b);
    let minPain = Infinity, maxPain = 0;
    strikes.forEach(s => {
      let pain = 0;
      callOI.forEach(c => { if (s > c.strike) pain += (s - c.strike) * c.oi; });
      putOI.forEach(p  => { if (s < p.strike) pain += (p.strike - s) * p.oi; });
      if (pain < minPain) { minPain = pain; maxPain = s; }
    });

    // ATM premiums
    const atm = Math.round(spot / 50) * 50;
    const atmCE  = callOI.find(c => c.strike === atm)      || callOI.find(c => c.strike === atm + 50) || {};
    const atmPE  = putOI.find(p  => p.strike === atm)      || putOI.find(p  => p.strike === atm - 50) || {};
    const otm1CE = callOI.find(c => c.strike === atm + 50) || {};
    const otm1PE = putOI.find(p  => p.strike === atm - 50) || {};

    const result = {
      spot,
      weeklyExpiry,
      monthlyExpiry,
      expiries: expDates.slice(0, 6),
      pcr,
      maxPain,
      totalCallOI,
      totalPutOI,
      topCallOI: [...callOI].sort((a,b) => b.oi - a.oi).slice(0, 6),
      topPutOI:  [...putOI].sort((a,b)  => b.oi - a.oi).slice(0, 6),
      premiums: {
        atmStrike: atm,
        atmCE:  { ltp: atmCE.ltp  || 0, iv: atmCE.iv  || 0, oi: atmCE.oi  || 0 },
        atmPE:  { ltp: atmPE.ltp  || 0, iv: atmPE.iv  || 0, oi: atmPE.oi  || 0 },
        otm1CE: { strike: atm + 50, ltp: otm1CE.ltp || 0, iv: otm1CE.iv || 0 },
        otm1PE: { strike: atm - 50, ltp: otm1PE.ltp || 0, iv: otm1PE.iv || 0 },
      },
      timestamp: new Date().toISOString(),
    };

    setCache("optionchain", result);
    res.json(result);
  } catch (err) {
    console.error("Option chain route:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE: Global Indices (Yahoo Finance)
// ══════════════════════════════════════════════════════════════
app.get("/api/global", async (req, res) => {
  const cached = getCache("global");
  if (cached) return res.json(cached);

  try {
    const [dji, spx, nasdaq, nikkei, hangseng, crude, dxy, gold] = await Promise.all([
      yahooGet("^DJI"),
      yahooGet("^GSPC"),
      yahooGet("^IXIC"),
      yahooGet("^N225"),
      yahooGet("^HSI"),
      yahooGet("CL=F"),
      yahooGet("DX-Y.NYB"),
      yahooGet("GC=F"),
    ]);

    const result = {
      us:          { dji, spx, nasdaq },
      asia:        { nikkei, hangseng },
      commodities: { crude, gold },
      dxy,
      timestamp: new Date().toISOString(),
    };

    setCache("global", result);
    res.json(result);
  } catch (err) {
    console.error("Global route:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE: FII / DII Data
// ══════════════════════════════════════════════════════════════
app.get("/api/fiidii", async (req, res) => {
  const cached = getCache("fiidii");
  if (cached) return res.json(cached);

  try {
    const data = await nseGet("/api/fiidiidata?type=cash");
    const today = Array.isArray(data) ? data[0] : {};
    const result = {
      date: today.date || "",
      fii:  { buy: today.fiiBuy  || 0, sell: today.fiiSell  || 0, net: today.fiinet  || today.fiiNet  || 0 },
      dii:  { buy: today.diiBuy  || 0, sell: today.diiSell  || 0, net: today.diinet  || today.diiNet  || 0 },
      timestamp: new Date().toISOString(),
    };
    setCache("fiidii", result);
    res.json(result);
  } catch (err) {
    console.error("FII/DII route:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE: All data in ONE call (fixes localhost bug from v1)
// ══════════════════════════════════════════════════════════════
app.get("/api/all", async (req, res) => {
  // Run all fetches in parallel directly (no localhost calls)
  const safeGet = async (fn) => {
    try { return await fn(); }
    catch (e) { return { error: e.message }; }
  };

  // Temporarily bypass cache for /api/all to get fresh data
  const [niftyData, ocData, globalData, fiiData] = await Promise.all([
    safeGet(async () => {
      const data = await nseGet("/api/allIndices");
      const indices = data?.data || [];
      const find = (sym) => indices.find(i => i.indexSymbol === sym) || {};
      const n = find("NIFTY 50"), v = find("INDIA VIX"), b = find("NIFTY BANK");
      return {
        nifty: { price: n.last||0, change: n.change||0, changePct: n.percentChange||0, high: n.high||0, low: n.low||0, open: n.open||0, prevClose: n.previousClose||0 },
        bankNifty: { price: b.last||0, changePct: b.percentChange||0 },
        vix: { value: v.last||0, change: v.change||0, changePct: v.percentChange||0, prevClose: v.previousClose||0, trend: (v.change||0)<0?"falling":"rising" },
      };
    }),
    safeGet(async () => {
      const data = await nseGet("/api/option-chain-indices?symbol=NIFTY");
      const records = data?.records?.data || [];
      const expDates = data?.records?.expiryDates || [];
      const spot = data?.records?.underlyingValue || 0;
      const weekly = expDates[0] || "";
      const monthly = expDates.find(d => new Date(d).getDate() >= 24) || expDates[expDates.length-1] || "";
      const near = records.filter(r => r.expiryDate === weekly);
      const callOI = [], putOI = [];
      let tCOI = 0, tPOI = 0;
      near.forEach(r => {
        if (r.CE) { callOI.push({ strike: r.strikePrice, oi: r.CE.openInterest||0, chgOI: r.CE.changeinOpenInterest||0, ltp: r.CE.lastPrice||0, iv: r.CE.impliedVolatility||0 }); tCOI += r.CE.openInterest||0; }
        if (r.PE) { putOI.push({  strike: r.strikePrice, oi: r.PE.openInterest||0, chgOI: r.PE.changeinOpenInterest||0, ltp: r.PE.lastPrice||0, iv: r.PE.impliedVolatility||0 }); tPOI += r.PE.openInterest||0; }
      });
      const pcr = tCOI > 0 ? +(tPOI/tCOI).toFixed(2) : 0;
      const atm = Math.round(spot/50)*50;
      const strikes = [...new Set(near.map(r=>r.strikePrice))];
      let minP = Infinity, maxPain = 0;
      strikes.forEach(s => {
        let pain = 0;
        callOI.forEach(c => { if(s>c.strike) pain+=(s-c.strike)*c.oi; });
        putOI.forEach(p  => { if(s<p.strike) pain+=(p.strike-s)*p.oi; });
        if(pain<minP){minP=pain;maxPain=s;}
      });
      const atmCE=callOI.find(c=>c.strike===atm)||callOI.find(c=>c.strike===atm+50)||{};
      const atmPE=putOI.find(p=>p.strike===atm)||putOI.find(p=>p.strike===atm-50)||{};
      const o1CE=callOI.find(c=>c.strike===atm+50)||{};
      const o1PE=putOI.find(p=>p.strike===atm-50)||{};
      return { spot, weeklyExpiry: weekly, monthlyExpiry: monthly, expiries: expDates.slice(0,5), pcr, maxPain, totalCallOI: tCOI, totalPutOI: tPOI, topCallOI: [...callOI].sort((a,b)=>b.oi-a.oi).slice(0,6), topPutOI: [...putOI].sort((a,b)=>b.oi-a.oi).slice(0,6), premiums: { atmStrike: atm, atmCE: {ltp:atmCE.ltp||0,iv:atmCE.iv||0,oi:atmCE.oi||0}, atmPE: {ltp:atmPE.ltp||0,iv:atmPE.iv||0,oi:atmPE.oi||0}, otm1CE:{strike:atm+50,ltp:o1CE.ltp||0,iv:o1CE.iv||0}, otm1PE:{strike:atm-50,ltp:o1PE.ltp||0,iv:o1PE.iv||0} } };
    }),
    safeGet(async () => {
      const [dji,spx,nasdaq,nikkei,hangseng,crude,dxy,gold] = await Promise.all([yahooGet("^DJI"),yahooGet("^GSPC"),yahooGet("^IXIC"),yahooGet("^N225"),yahooGet("^HSI"),yahooGet("CL=F"),yahooGet("DX-Y.NYB"),yahooGet("GC=F")]);
      return { us:{dji,spx,nasdaq}, asia:{nikkei,hangseng}, commodities:{crude,gold}, dxy };
    }),
    safeGet(async () => {
      const data = await nseGet("/api/fiidiidata?type=cash");
      const t = Array.isArray(data)?data[0]:{};
      return { date:t.date||"", fii:{buy:t.fiiBuy||0,sell:t.fiiSell||0,net:t.fiinet||t.fiiNet||0}, dii:{buy:t.diiBuy||0,sell:t.diiSell||0,net:t.diinet||t.diiNet||0} };
    }),
  ]);

  res.json({
    nifty:       niftyData?.nifty       || null,
    vix:         niftyData?.vix         || null,
    bankNifty:   niftyData?.bankNifty   || null,
    optionchain: ocData                  || null,
    global:      globalData              || null,
    fiidii:      fiiData                 || null,
    fetchedAt:   new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`NIFTY Trade Engine v2 running on port ${PORT}`));
