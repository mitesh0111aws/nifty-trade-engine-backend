// ============================================================
// NIFTY Trade Engine — Backend Server
// Deploy FREE on Render.com
// Node.js 18+ required
// ============================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors()); // Allow your Claude artifact to call this
app.use(express.json());

// ── NSE headers (mimic browser to avoid 401/403) ──────────────
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.nseindia.com/",
  "Connection": "keep-alive",
};

// ── Cache to avoid hammering NSE (30 sec TTL) ─────────────────
const cache = {};
function getCache(key) {
  const e = cache[key];
  if (e && Date.now() - e.ts < 30000) return e.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// ── Axios NSE instance ─────────────────────────────────────────
const nseAxios = axios.create({
  baseURL: "https://www.nseindia.com",
  timeout: 10000,
  headers: NSE_HEADERS,
});

// Prime NSE cookies (required before data calls)
let nseCookies = "";
async function primeNSE() {
  try {
    const r = await nseAxios.get("/");
    const cookies = r.headers["set-cookie"];
    if (cookies) nseCookies = cookies.map(c => c.split(";")[0]).join("; ");
  } catch (e) {
    console.error("NSE prime failed:", e.message);
  }
}
primeNSE(); // Run on startup
setInterval(primeNSE, 5 * 60 * 1000); // Re-prime every 5 min

// ── Helper: NSE GET with cookies ──────────────────────────────
async function nseGet(path) {
  const r = await nseAxios.get(path, {
    headers: { ...NSE_HEADERS, Cookie: nseCookies }
  });
  return r.data;
}

// ══════════════════════════════════════════════════════════════
// ROUTE 1: NIFTY Quote + VIX + Market Status
// ══════════════════════════════════════════════════════════════
app.get("/api/nifty", async (req, res) => {
  const cached = getCache("nifty");
  if (cached) return res.json(cached);

  try {
    const [quoteData, vixData] = await Promise.all([
      nseGet("/api/allIndices"),
      nseGet("/api/allIndices"),
    ]);

    const indices = quoteData.data || [];
    const nifty50 = indices.find(i => i.indexSymbol === "NIFTY 50") || {};
    const vix = indices.find(i => i.indexSymbol === "INDIA VIX") || {};
    const bankNifty = indices.find(i => i.indexSymbol === "NIFTY BANK") || {};
    const midcap = indices.find(i => i.indexSymbol === "NIFTY MIDCAP 100") || {};

    const result = {
      nifty: {
        price: nifty50.last || 0,
        change: nifty50.change || 0,
        changePct: nifty50.percentChange || 0,
        high: nifty50.high || 0,
        low: nifty50.low || 0,
        open: nifty50.open || 0,
        prevClose: nifty50.previousClose || 0,
      },
      bankNifty: {
        price: bankNifty.last || 0,
        changePct: bankNifty.percentChange || 0,
      },
      midcap: {
        price: midcap.last || 0,
        changePct: midcap.percentChange || 0,
      },
      vix: {
        value: vix.last || 0,
        change: vix.change || 0,
        changePct: vix.percentChange || 0,
        prevClose: vix.previousClose || 0,
        trend: (vix.change || 0) < 0 ? "falling" : "rising",
      },
      timestamp: new Date().toISOString(),
    };

    setCache("nifty", result);
    res.json(result);
  } catch (err) {
    console.error("NIFTY route error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE 2: NIFTY Option Chain (OI, PCR, Max Pain, Premiums)
// ══════════════════════════════════════════════════════════════
app.get("/api/optionchain", async (req, res) => {
  const cached = getCache("optionchain");
  if (cached) return res.json(cached);

  try {
    const data = await nseGet("/api/option-chain-indices?symbol=NIFTY");
    const records = data?.records?.data || [];
    const expDates = data?.records?.expiryDates || [];
    const atmStrike = data?.records?.underlyingValue || 0;

    // Get weekly (nearest) and monthly expiries
    const weeklyExpiry = expDates[0] || "";
    const monthlyExpiry = expDates.find(d => {
      const dt = new Date(d);
      return dt.getDate() >= 25;
    }) || expDates[expDates.length - 1] || "";

    // Compute max pain and OI for nearest expiry
    const nearExpiry = weeklyExpiry;
    const nearData = records.filter(r => r.expiryDate === nearExpiry);

    const callOI = [], putOI = [];
    let totalCallOI = 0, totalPutOI = 0;
    const painData = [];

    nearData.forEach(r => {
      if (r.CE) {
        callOI.push({ strike: r.strikePrice, oi: r.CE.openInterest, chgOI: r.CE.changeinOpenInterest, ltp: r.CE.lastPrice, iv: r.CE.impliedVolatility });
        totalCallOI += r.CE.openInterest || 0;
      }
      if (r.PE) {
        putOI.push({ strike: r.strikePrice, oi: r.PE.openInterest, chgOI: r.PE.changeinOpenInterest, ltp: r.PE.lastPrice, iv: r.PE.impliedVolatility });
        totalPutOI += r.PE.openInterest || 0;
      }
    });

    const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 0;

    // Max pain calculation
    const strikes = [...new Set(nearData.map(r => r.strikePrice))];
    let minPain = Infinity, maxPainStrike = 0;
    strikes.forEach(s => {
      let pain = 0;
      nearData.forEach(r => {
        if (r.CE && s > r.strikePrice) pain += (s - r.strikePrice) * r.CE.openInterest;
        if (r.PE && s < r.strikePrice) pain += (r.strikePrice - s) * r.PE.openInterest;
      });
      if (pain < minPain) { minPain = pain; maxPainStrike = s; }
    });

    // Get ATM premium (CE and PE at nearest strike to spot)
    const atmRound = Math.round(atmStrike / 50) * 50;
    const atmCE = callOI.find(c => c.strike === atmRound) || callOI.find(c => c.strike === atmRound + 50) || {};
    const atmPE = putOI.find(p => p.strike === atmRound) || putOI.find(p => p.strike === atmRound - 50) || {};
    const otm1CE = callOI.find(c => c.strike === atmRound + 50) || {};
    const otm1PE = putOI.find(p => p.strike === atmRound - 50) || {};

    const topCallOI = [...callOI].sort((a, b) => b.oi - a.oi).slice(0, 5);
    const topPutOI = [...putOI].sort((a, b) => b.oi - a.oi).slice(0, 5);

    const result = {
      spot: atmStrike,
      weeklyExpiry,
      monthlyExpiry,
      expiries: expDates.slice(0, 5),
      pcr: parseFloat(pcr),
      maxPain: maxPainStrike,
      totalCallOI,
      totalPutOI,
      topCallOI,
      topPutOI,
      premiums: {
        atmStrike: atmRound,
        atmCE: { ltp: atmCE.ltp || 0, iv: atmCE.iv || 0, oi: atmCE.oi || 0 },
        atmPE: { ltp: atmPE.ltp || 0, iv: atmPE.iv || 0, oi: atmPE.oi || 0 },
        otm1CE: { strike: atmRound + 50, ltp: otm1CE.ltp || 0, iv: otm1CE.iv || 0 },
        otm1PE: { strike: atmRound - 50, ltp: otm1PE.ltp || 0, iv: otm1PE.iv || 0 },
      },
      timestamp: new Date().toISOString(),
    };

    setCache("optionchain", result);
    res.json(result);
  } catch (err) {
    console.error("Option chain error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE 3: Global Indices (Yahoo Finance — free, no key needed)
// ══════════════════════════════════════════════════════════════
app.get("/api/global", async (req, res) => {
  const cached = getCache("global");
  if (cached) return res.json(cached);

  const symbols = {
    dji: "%5EDJI",       // Dow Jones
    spx: "%5EGSPC",      // S&P 500
    nasdaq: "%5EIXIC",   // NASDAQ
    nikkei: "%5EN225",   // Nikkei
    hangseng: "%5EHSI",  // Hang Seng
    sgxNifty: "^SGXNIFTY", // SGX Nifty (may not be on Yahoo)
    crudeoil: "CL=F",    // Crude Oil Futures
    dxy: "DX-Y.NYB",     // Dollar Index
    gold: "GC=F",        // Gold
  };

  const fetch1 = async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
      const r = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const meta = r.data?.chart?.result?.[0]?.meta || {};
      return {
        price: meta.regularMarketPrice || 0,
        prevClose: meta.chartPreviousClose || meta.previousClose || 0,
        change: (meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice)) || 0,
        changePct: meta.regularMarketPrice && meta.chartPreviousClose
          ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2)
          : "0.00",
      };
    } catch { return { price: 0, changePct: "0.00", change: 0 }; }
  };

  try {
    const [dji, spx, nasdaq, nikkei, hangseng, crudeoil, dxy, gold] = await Promise.all([
      fetch1(symbols.dji), fetch1(symbols.spx), fetch1(symbols.nasdaq),
      fetch1(symbols.nikkei), fetch1(symbols.hangseng),
      fetch1(symbols.crudeoil), fetch1(symbols.dxy), fetch1(symbols.gold),
    ]);

    const fmt = (v) => {
      const n = parseFloat(v.changePct);
      return { price: v.price, changePct: n.toFixed(2), sign: n >= 0 ? "+" : "", change: v.change };
    };

    const result = {
      us: { dji: fmt(dji), spx: fmt(spx), nasdaq: fmt(nasdaq) },
      asia: { nikkei: fmt(nikkei), hangseng: fmt(hangseng) },
      commodities: { crude: fmt(crudeoil), gold: fmt(gold) },
      dxy: fmt(dxy),
      timestamp: new Date().toISOString(),
    };

    setCache("global", result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE 4: GIFT NIFTY (SGX Nifty)
// ══════════════════════════════════════════════════════════════
app.get("/api/giftnifty", async (req, res) => {
  const cached = getCache("giftnifty");
  if (cached) return res.json(cached);

  try {
    // Try Yahoo Finance SGX Nifty ticker
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/NIFTY_I.NS?interval=1m&range=1d";
    const r = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
    const meta = r.data?.chart?.result?.[0]?.meta || {};
    const result = {
      price: meta.regularMarketPrice || 0,
      prevClose: meta.chartPreviousClose || 0,
      changePct: meta.regularMarketPrice && meta.chartPreviousClose
        ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2)
        : "0.00",
      timestamp: new Date().toISOString(),
    };
    setCache("giftnifty", result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, note: "GIFT Nifty not available — use NSE futures as proxy" });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE 5: FII/DII Data (NSE)
// ══════════════════════════════════════════════════════════════
app.get("/api/fiidii", async (req, res) => {
  const cached = getCache("fiidii");
  if (cached) return res.json(cached);

  try {
    const data = await nseGet("/api/fiidiidata?type=cash");
    const today = data?.[0] || {};
    const result = {
      date: today.date || "",
      fii: {
        buy: today.fiiBuy || 0,
        sell: today.fiiSell || 0,
        net: today.fiinet || 0,
      },
      dii: {
        buy: today.diiBuy || 0,
        sell: today.diiSell || 0,
        net: today.diinet || 0,
      },
      timestamp: new Date().toISOString(),
    };
    setCache("fiidii", result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE 6: All data in one call (used by artifact on load)
// ══════════════════════════════════════════════════════════════
app.get("/api/all", async (req, res) => {
  try {
    const [nifty, optionchain, global, fiidii] = await Promise.allSettled([
      axios.get(`http://localhost:${PORT}/api/nifty`),
      axios.get(`http://localhost:${PORT}/api/optionchain`),
      axios.get(`http://localhost:${PORT}/api/global`),
      axios.get(`http://localhost:${PORT}/api/fiidii`),
    ]);

    res.json({
      nifty: nifty.status === "fulfilled" ? nifty.value.data : null,
      optionchain: optionchain.status === "fulfilled" ? optionchain.value.data : null,
      global: global.status === "fulfilled" ? global.value.data : null,
      fiidii: fiidii.status === "fulfilled" ? fiidii.value.data : null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "NIFTY Trade Engine Backend running", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
