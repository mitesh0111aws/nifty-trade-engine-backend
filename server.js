// ================================================================
// NIFTY Trade Engine — Backend Server FINAL
// Features:
//   ✅ CORS fixed (Claude artifact can now connect)
//   ✅ Live NSE data (NIFTY, VIX, OI, PCR, premiums)
//   ✅ Yahoo Finance (global indices, crude, gold, DXY)
//   ✅ Auto Telegram alerts (works even when Claude is CLOSED)
//   ✅ Market news monitoring
//   ✅ Telegram Chat ID helper endpoint
// ================================================================

const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS: allow ALL origins (fixes "Failed to fetch" in Claude) ──
app.use(cors({
  origin: "*",
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options("*", cors());
app.use(express.json());

// ================================================================
// TELEGRAM CONFIG  (set via env vars on Render OR via /api/config)
// ================================================================
let TG_TOKEN  = process.env.TG_TOKEN  || "";
let TG_CHATID = process.env.TG_CHATID || "";

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHATID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHATID,
      text: msg,
      parse_mode: "HTML",
    });
  } catch (e) { console.error("Telegram send error:", e.message); }
}

// ================================================================
// CACHE (30s TTL)
// ================================================================
const cache = {};
const getCache = (k)    => { const e=cache[k]; return e&&Date.now()-e.ts<30000?e.data:null; };
const setCache = (k, d) => { cache[k]={data:d, ts:Date.now()}; };

// ================================================================
// NSE SESSION
// ================================================================
const NSE_HEADERS = {
  "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
  "Accept"         : "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin"         : "https://www.nseindia.com",
  "Referer"        : "https://www.nseindia.com/",
  "Connection"     : "keep-alive",
};

let nseCookies    = "";
let nseSessionOk  = false;

const nseClient = axios.create({ baseURL:"https://www.nseindia.com", timeout:12000, headers:NSE_HEADERS });

async function primeNSE() {
  try {
    const r1 = await nseClient.get("/");
    const c1 = (r1.headers["set-cookie"]||[]).map(c=>c.split(";")[0]);
    const r2 = await nseClient.get("/market-data/live-equity-market", {
      headers:{ ...NSE_HEADERS, Cookie:c1.join("; ") }
    });
    const c2 = (r2.headers["set-cookie"]||[]).map(c=>c.split(";")[0]);
    nseCookies   = [...new Set([...c1,...c2])].join("; ");
    nseSessionOk = true;
    console.log("✅ NSE session primed");
  } catch (e) {
    nseSessionOk = false;
    console.error("❌ NSE prime failed:", e.message);
  }
}

primeNSE();
setInterval(primeNSE, 4*60*1000);

async function nseGet(path) {
  if (!nseSessionOk) await primeNSE();
  const r = await nseClient.get(path, { headers:{ ...NSE_HEADERS, Cookie:nseCookies } });
  return r.data;
}

// ================================================================
// YAHOO FINANCE HELPER
// ================================================================
async function yahooGet(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r   = await axios.get(url, { headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}, timeout:8000 });
    const meta = r.data?.chart?.result?.[0]?.meta || {};
    const price = meta.regularMarketPrice    || 0;
    const prev  = meta.chartPreviousClose    || meta.previousClose || price;
    const chg   = price - prev;
    const chgPct= prev ? ((chg/prev)*100).toFixed(2) : "0.00";
    return { price:+price.toFixed(2), change:+chg.toFixed(2), changePct:chgPct, prevClose:+prev.toFixed(2) };
  } catch(e) {
    console.error(`Yahoo ${symbol}:`, e.message);
    return { price:0, change:0, changePct:"0.00", prevClose:0 };
  }
}

// ================================================================
// MARKET STATUS (IST)
// ================================================================
function getMarketStatus() {
  const now  = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const day  = now.getDay();
  const mins = now.getHours()*60 + now.getMinutes();
  if (day===0||day===6)  return { open:false, phase:"closed",         label:"Weekend" };
  if (mins < 555)        return { open:false, phase:"pre",            label:"Pre-Market" };
  if (mins <= 560)       return { open:true,  phase:"caution_open",   label:"Opening caution (first 5 min)" };
  if (mins <= 615)       return { open:true,  phase:"opening",        label:"Opening Session" };
  if (mins <= 840)       return { open:true,  phase:"mid",            label:"Mid Session" };
  if (mins <= 885)       return { open:true,  phase:"closing",        label:"Closing Session" };
  if (mins < 930)        return { open:true,  phase:"caution_close",  label:"After 2:45 — no fresh trades" };
  return                        { open:false, phase:"closed",         label:"Market Closed" };
}

// ================================================================
// FETCH ALL MARKET DATA (shared logic)
// ================================================================
async function fetchAllData() {
  const safe = async (fn) => { try { return await fn(); } catch(e) { return { error:e.message }; } };

  const [niftyRaw, ocRaw, globalRaw, fiiRaw, newsRaw] = await Promise.all([
    // NIFTY + VIX
    safe(async () => {
      const d = await nseGet("/api/allIndices");
      const find = (sym) => (d?.data||[]).find(i=>i.indexSymbol===sym)||{};
      const n=find("NIFTY 50"), v=find("INDIA VIX"), b=find("NIFTY BANK"),
            m=find("NIFTY MIDCAP 100"), s=find("NIFTY SMALLCAP 100"),
            f=find("NIFTY 500"), it=find("NIFTY IT"), psu=find("NIFTY PSU BANK"),
            fin=find("NIFTY FIN SERVICE"), auto=find("NIFTY AUTO");
      return {
        nifty:    { price:n.last||0, change:n.change||0, changePct:n.percentChange||0, high:n.high||0, low:n.low||0, open:n.open||0, prevClose:n.previousClose||0 },
        bankNifty:{ price:b.last||0, change:b.change||0, changePct:b.percentChange||0, high:b.high||0, low:b.low||0 },
        midcap:   { price:m.last||0, changePct:m.percentChange||0 },
        smallcap: { price:s.last||0, changePct:s.percentChange||0 },
        nifty500: { price:f.last||0, changePct:f.percentChange||0 },
        sectors:  {
          it:   { price:it.last||0,   changePct:it.percentChange||0 },
          psu:  { price:psu.last||0,  changePct:psu.percentChange||0 },
          fin:  { price:fin.last||0,  changePct:fin.percentChange||0 },
          auto: { price:auto.last||0, changePct:auto.percentChange||0 },
        },
        vix: { value:v.last||0, change:v.change||0, changePct:v.percentChange||0, prevClose:v.previousClose||0, trend:(v.change||0)<0?"falling":"rising" },
      };
    }),

    // Option Chain
    safe(async () => {
      const d       = await nseGet("/api/option-chain-indices?symbol=NIFTY");
      const records = d?.records?.data        || [];
      const expDates= d?.records?.expiryDates || [];
      const spot    = d?.records?.underlyingValue || 0;
      const weekly  = expDates[0] || "";
      const monthly = expDates.find(x=>new Date(x).getDate()>=24)||expDates[expDates.length-1]||"";
      const near    = records.filter(r=>r.expiryDate===weekly);
      const callOI=[], putOI=[];
      let tCOI=0, tPOI=0;
      near.forEach(r=>{
        if(r.CE){ callOI.push({strike:r.strikePrice,oi:r.CE.openInterest||0,chgOI:r.CE.changeinOpenInterest||0,ltp:r.CE.lastPrice||0,iv:r.CE.impliedVolatility||0}); tCOI+=r.CE.openInterest||0; }
        if(r.PE){ putOI.push( {strike:r.strikePrice,oi:r.PE.openInterest||0,chgOI:r.PE.changeinOpenInterest||0,ltp:r.PE.lastPrice||0,iv:r.PE.impliedVolatility||0}); tPOI+=r.PE.openInterest||0; }
      });
      const pcr = tCOI>0 ? +(tPOI/tCOI).toFixed(2) : 0;
      const atm = Math.round(spot/50)*50;
      const strikes=[...new Set(near.map(r=>r.strikePrice))];
      let minP=Infinity,maxPain=0;
      strikes.forEach(s=>{ let pain=0; callOI.forEach(c=>{if(s>c.strike)pain+=(s-c.strike)*c.oi;}); putOI.forEach(p=>{if(s<p.strike)pain+=(p.strike-s)*p.oi;}); if(pain<minP){minP=pain;maxPain=s;} });
      const atmCE=callOI.find(c=>c.strike===atm)||callOI.find(c=>c.strike===atm+50)||{};
      const atmPE=putOI.find(p=>p.strike===atm)||putOI.find(p=>p.strike===atm-50)||{};
      const o1CE=callOI.find(c=>c.strike===atm+50)||{};
      const o1PE=putOI.find(p=>p.strike===atm-50)||{};
      return { spot, weeklyExpiry:weekly, monthlyExpiry:monthly, expiries:expDates.slice(0,6), pcr, maxPain, totalCallOI:tCOI, totalPutOI:tPOI, topCallOI:[...callOI].sort((a,b)=>b.oi-a.oi).slice(0,6), topPutOI:[...putOI].sort((a,b)=>b.oi-a.oi).slice(0,6), premiums:{ atmStrike:atm, atmCE:{ltp:atmCE.ltp||0,iv:atmCE.iv||0,oi:atmCE.oi||0}, atmPE:{ltp:atmPE.ltp||0,iv:atmPE.iv||0,oi:atmPE.oi||0}, otm1CE:{strike:atm+50,ltp:o1CE.ltp||0,iv:o1CE.iv||0}, otm1PE:{strike:atm-50,ltp:o1PE.ltp||0,iv:o1PE.iv||0} } };
    }),

    // Global (Yahoo)
    safe(async () => {
      const [dji,spx,nasdaq,nikkei,hangseng,sgx,crude,dxy,gold] = await Promise.all([
        yahooGet("^DJI"), yahooGet("^GSPC"), yahooGet("^IXIC"),
        yahooGet("^N225"), yahooGet("^HSI"), yahooGet("^NSEI"),
        yahooGet("CL=F"), yahooGet("DX-Y.NYB"), yahooGet("GC=F"),
      ]);
      return { us:{dji,spx,nasdaq}, asia:{nikkei,hangseng,sgx}, commodities:{crude,gold}, dxy };
    }),

    // FII/DII
    safe(async () => {
      const d = await nseGet("/api/fiidiidata?type=cash");
      const t = Array.isArray(d)?d[0]:{};
      return { date:t.date||"", fii:{buy:t.fiiBuy||0,sell:t.fiiSell||0,net:t.fiinet||t.fiiNet||0}, dii:{buy:t.diiBuy||0,sell:t.diiSell||0,net:t.diinet||t.diiNet||0} };
    }),

    // News headlines (Google RSS — no key needed)
    safe(async () => {
      const r = await axios.get("https://news.google.com/rss/search?q=NIFTY+india+stock+market&hl=en-IN&gl=IN&ceid=IN:en", { timeout:8000, headers:{"User-Agent":"Mozilla/5.0"} });
      const items = (r.data||"").match(/<title>(.*?)<\/title>/g)||[];
      return items.slice(1,8).map(t=>t.replace(/<\/?title>/g,"").trim());
    }),
  ]);

  return {
    nifty:       niftyRaw?.nifty       || null,
    bankNifty:   niftyRaw?.bankNifty   || null,
    midcap:      niftyRaw?.midcap      || null,
    smallcap:    niftyRaw?.smallcap    || null,
    nifty500:    niftyRaw?.nifty500    || null,
    sectors:     niftyRaw?.sectors     || null,
    vix:         niftyRaw?.vix         || null,
    optionchain: ocRaw?.error          ? null : ocRaw,
    global:      globalRaw?.error      ? null : globalRaw,
    fiidii:      fiiRaw?.error         ? null : fiiRaw,
    news:        Array.isArray(newsRaw) ? newsRaw : [],
    marketStatus: getMarketStatus(),
    fetchedAt:   new Date().toISOString(),
  };
}

// ================================================================
// AUTO TRADE SIGNAL LOGIC (runs on server — works offline!)
// ================================================================
let lastSignalSent = ""; // track to avoid duplicate alerts

function evaluateSignal(data) {
  if (!data?.nifty?.price) return null;
  const status = data.marketStatus;
  if (!status.open || ["caution_open","caution_close","closed","pre"].includes(status.phase)) return null;

  const chgPct = parseFloat(data.nifty?.changePct || 0);
  const vix    = parseFloat(data.vix?.value       || 15);
  const vixTrend=data.vix?.trend || "rising";
  const pcr    = parseFloat(data.optionchain?.pcr  || 1);
  const fiiNet = parseFloat(data.fiidii?.fii?.net  || 0);
  const tCOI   = data.optionchain?.totalCallOI     || 0;
  const tPOI   = data.optionchain?.totalPutOI      || 0;

  const bullScore = [
    chgPct > 0.2, pcr > 1.0, vixTrend==="falling", vix<16,
    fiiNet > 200, chgPct > 0, tPOI > tCOI, vix < 18,
  ].filter(Boolean).length;

  const bearScore = [
    chgPct < -0.2, pcr < 0.85, vixTrend==="rising", vix > 20,
    fiiNet < -500, chgPct < 0, tCOI > tPOI*1.3, vix > 22,
  ].filter(Boolean).length;

  let tradeType=null, confidence="Low";
  if (bullScore>=6)      { tradeType="CE"; confidence=bullScore>=7?"HIGH":"MEDIUM"; }
  else if (bearScore>=6) { tradeType="PE"; confidence=bearScore>=7?"HIGH":"MEDIUM"; }

  if (!tradeType || confidence==="Low") return null;

  const prem   = data.optionchain?.premiums || {};
  const atm    = prem.atmStrike || Math.round(data.nifty.price/50)*50;
  const entry  = tradeType==="CE" ? (prem.otm1CE?.ltp||prem.atmCE?.ltp||0) : (prem.otm1PE?.ltp||prem.atmPE?.ltp||0);
  if (entry < 5) return null; // invalid premium
  const strike = atm + (tradeType==="CE"?50:-50);
  const t1     = Math.round(entry*1.35);
  const t2     = Math.round(entry*1.70);
  const sl     = Math.round(entry*0.62);

  return { tradeType, strike, entry, t1, t2, sl, confidence, bullScore, bearScore, pcr, vix, fiiNet, nifty:data.nifty.price };
}

// ================================================================
// AUTO MONITOR (every 5 min during market hours)
// ================================================================
let monitorData = null;

async function runMonitor() {
  const status = getMarketStatus();
  if (!status.open) return;
  console.log("🔍 Monitor running:", new Date().toISOString());
  try {
    monitorData = await fetchAllData();
    const sig   = evaluateSignal(monitorData);
    if (!sig) return;

    const sigKey = `${sig.tradeType}_${sig.strike}_${sig.confidence}`;
    if (sigKey === lastSignalSent) return; // don't repeat same alert
    lastSignalSent = sigKey;

    const msg = `🚨 <b>NIFTY TRADE SIGNAL</b>
━━━━━━━━━━━━━━━━━━━
📌 <b>${sig.tradeType} ${sig.strike}</b> | ${sig.confidence} CONFIDENCE
💰 Entry: ₹${sig.entry}
🎯 T1: ₹${sig.t1} | T2: ₹${sig.t2}
🛑 SL: ₹${sig.sl}
━━━━━━━━━━━━━━━━━━━
📊 NIFTY: ${sig.nifty} | PCR: ${sig.pcr} | VIX: ${sig.vix}
🏦 FII: ₹${sig.fiiNet}Cr | Bull/Bear: ${sig.bullScore}/${sig.bearScore}
⏰ ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}
━━━━━━━━━━━━━━━━━━━
⚠️ Always verify on Zerodha before placing. Not SEBI advice.`;

    await sendTelegram(msg);
    console.log("✅ Telegram alert sent:", sigKey);
  } catch(e) {
    console.error("Monitor error:", e.message);
  }
}

// Start monitor: every 5 minutes
setInterval(runMonitor, 5*60*1000);

// VIX spike alert (every 10 min)
setInterval(async () => {
  if (!getMarketStatus().open || !monitorData?.vix?.value) return;
  const vix = parseFloat(monitorData.vix.value);
  if (vix > 18) {
    await sendTelegram(`⚠️ <b>VIX SPIKE ALERT</b>\nVIX = <b>${vix}</b> — above 18!\nAvoid buying options. High premium, high risk.\nTime: ${new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})}`);
  }
}, 10*60*1000);

// ================================================================
// ROUTES
// ================================================================

// Health
app.get("/", (req, res) => res.json({
  status: "NIFTY Trade Engine FINAL running",
  nseSession: nseSessionOk,
  telegramConfigured: !!(TG_TOKEN && TG_CHATID),
  marketStatus: getMarketStatus(),
  time: new Date().toISOString(),
}));

// All data (main endpoint used by artifact)
app.get("/api/all", async (req, res) => {
  try {
    const data = await fetchAllData();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Individual routes (for testing)
app.get("/api/nifty",       async (req,res) => { try { const d=await fetchAllData(); res.json({nifty:d.nifty,vix:d.vix,bankNifty:d.bankNifty,sectors:d.sectors}); } catch(e){res.status(500).json({error:e.message});} });
app.get("/api/optionchain", async (req,res) => { try { const d=await fetchAllData(); res.json(d.optionchain); }    catch(e){res.status(500).json({error:e.message});} });
app.get("/api/global",      async (req,res) => { try { const d=await fetchAllData(); res.json(d.global); }         catch(e){res.status(500).json({error:e.message});} });
app.get("/api/fiidii",      async (req,res) => { try { const d=await fetchAllData(); res.json(d.fiidii); }         catch(e){res.status(500).json({error:e.message});} });
app.get("/api/news",        async (req,res) => { try { const d=await fetchAllData(); res.json(d.news); }           catch(e){res.status(500).json({error:e.message});} });

// Telegram: save config
app.post("/api/telegram/config", (req, res) => {
  const { token, chatId } = req.body;
  if (token)  TG_TOKEN  = token;
  if (chatId) TG_CHATID = chatId;
  res.json({ ok:true, configured:!!(TG_TOKEN&&TG_CHATID) });
});

// Telegram: get chat ID from updates (artifact calls this instead of Telegram directly)
app.get("/api/telegram/chatid", async (req, res) => {
  const token = req.query.token || TG_TOKEN;
  if (!token) return res.status(400).json({ error:"No token provided" });
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
    const results = r.data?.result || [];
    if (!results.length) return res.json({ chatId:null, message:"No messages found. Send a message to your bot on Telegram first." });
    const chatId = results[results.length-1]?.message?.chat?.id || results[0]?.message?.chat?.id;
    if (TG_TOKEN===token) TG_CHATID=String(chatId);
    res.json({ chatId: String(chatId), ok:true });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// Telegram: send test alert
app.post("/api/telegram/test", async (req, res) => {
  const { token, chatId } = req.body;
  const t = token  || TG_TOKEN;
  const c = chatId || TG_CHATID;
  if (!t||!c) return res.status(400).json({ error:"Token and chatId required" });
  try {
    await axios.post(`https://api.telegram.org/bot${t}/sendMessage`, {
      chat_id:c, text:`✅ <b>NIFTY Trade Engine — Test Alert</b>\n\nAlerts are working!\nServer time: ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}\n\nYou'll receive trade signals here automatically during market hours, even when Claude is closed. 🚀`, parse_mode:"HTML"
    });
    res.json({ ok:true });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// Manually trigger signal check
app.get("/api/signal/check", async (req,res) => {
  try {
    const data = await fetchAllData();
    const sig  = evaluateSignal(data);
    res.json({ signal:sig, marketStatus:data.marketStatus });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// News
app.get("/api/news/live", async (req, res) => {
  try {
    const r = await axios.get("https://news.google.com/rss/search?q=NIFTY+sensex+india+market&hl=en-IN&gl=IN&ceid=IN:en", { timeout:8000, headers:{"User-Agent":"Mozilla/5.0"} });
    const items = (r.data||"").match(/<item>([\s\S]*?)<\/item>/g)||[];
    const news  = items.slice(0,10).map(item=>{
      const title = (item.match(/<title>(.*?)<\/title>/)||[])[1]||"";
      const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/)||[])[1]||"";
      return { title:title.replace(/<!\[CDATA\[|\]\]>/g,"").trim(), pub };
    });
    res.json(news);
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 NIFTY Trade Engine FINAL on port ${PORT}`));
