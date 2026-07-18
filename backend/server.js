/**
 * MarketPulse backend — live market analytics engine.
 *
 * ARCHITECTURE
 *   Free market-data APIs are rate-limited (~60 req/min). Rather than every browser
 *   hitting the API, ONE backend polls on a schedule, computes analytics, caches the
 *   result, and fans it out to all connected clients over WebSocket.
 *   => N clients cost the same upstream API budget as 1.
 *
 * Also tracks its own operational metrics (clients, broadcasts, cache hits, API calls
 * saved) and exposes them to the dashboard — the system observes itself.
 */
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY  = process.env.FINNHUB_API_KEY || "demo";
const PORT     = process.env.PORT || 4000;
const POLL_MS   = 5000;           // how often we BROADCAST to clients
const BATCH      = 2;             // symbols refreshed per poll (rate-limit budget)
const CACHE_TTL  = 15000;         // serve cached quote if younger than this
const HISTORY    = 90;            // ticks retained per symbol
// Rate-limit math: Finnhub free = 30 req/min.
//   BATCH(2) x (60000/POLL_MS = 12 polls/min) = 24 calls/min  -> safely under 30.
// Each symbol refreshes every (SYMBOLS.length / BATCH) x POLL_MS = 20s, but the
// dashboard still receives a broadcast every 5s so it always feels live.

const SYMBOLS = ["AAPL","MSFT","GOOGL","AMZN","TSLA","NVDA","META","JPM"];
const NAMES = { AAPL:"Apple", MSFT:"Microsoft", GOOGL:"Alphabet", AMZN:"Amazon",
                TSLA:"Tesla", NVDA:"NVIDIA", META:"Meta", JPM:"JPMorgan" };

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ---------------- state ----------------
const state = {};
SYMBOLS.forEach(s => { state[s] = { symbol:s, name:NAMES[s], price:null, prevClose:null,
                                    changePct:null, history:[], analytics:{} }; });

const cache = new Map();          // symbol -> { data, ts }
const metrics = {
  startedAt: Date.now(),
  clients: 0, peakClients: 0,
  broadcasts: 0, upstreamCalls: 0, cacheHits: 0, errors: 0,
  lastPollMs: 0,
};

// ---------------- analytics ----------------
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;

function computeAnalytics(history) {
  if (history.length < 3) return { sma:null, ema:null, volatility:null, trend:"flat",
                                   momentum:null, high:null, low:null, signal:"hold" };
  const p = history.map(h=>h.price);
  const sma = mean(p);

  // exponential moving average — weights recent prices more heavily
  const k = 2/(p.length+1);
  const ema = p.reduce((acc,x,i)=> i===0 ? x : x*k + acc*(1-k), 0);

  // volatility = std-dev of tick-to-tick % returns (annualisation-free, comparable across prices)
  const returns = p.slice(1).map((x,i)=> (x-p[i])/p[i]*100);
  const volatility = returns.length ? Math.sqrt(mean(returns.map(r=>(r-mean(returns))**2))) : 0;

  const momentum = (p[p.length-1]-p[0])/p[0]*100;         // % change over window
  const trend = momentum > 0.05 ? "up" : momentum < -0.05 ? "down" : "flat";

  // breakout signal: price crossing its own moving average
  const last = p[p.length-1];
  const signal = last > sma*1.002 ? "bullish" : last < sma*0.998 ? "bearish" : "neutral";

  return { sma:+sma.toFixed(2), ema:+ema.toFixed(2), volatility:+volatility.toFixed(3),
           trend, momentum:+momentum.toFixed(2),
           high:+Math.max(...p).toFixed(2), low:+Math.min(...p).toFixed(2), signal };
}

// Pearson correlation between two symbols' return series — cross-asset analytics
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const ra = a.slice(-n).map(h=>h.price), rb = b.slice(-n).map(h=>h.price);
  const ma = mean(ra), mb = mean(rb);
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++){ const x=ra[i]-ma, y=rb[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  return (da&&db) ? +(num/Math.sqrt(da*db)).toFixed(2) : null;
}

function marketSummary() {
  const list = Object.values(state).filter(s=>s.price!=null);
  if (!list.length) return { gainers:0, losers:0, avgChange:0, health:50, mostVolatile:null, topMover:null };
  const gainers = list.filter(s=>s.changePct>0).length;
  const losers  = list.filter(s=>s.changePct<0).length;
  const avgChange = +mean(list.map(s=>s.changePct||0)).toFixed(2);
  const vols = list.filter(s=>s.analytics?.volatility!=null);
  const mostVolatile = vols.length ? vols.reduce((a,b)=> a.analytics.volatility>b.analytics.volatility?a:b).symbol : null;
  const topMover = list.reduce((a,b)=> Math.abs(a.changePct||0)>Math.abs(b.changePct||0)?a:b).symbol;
  // market health 0-100: breadth (how many advancing) blended with average move
  const breadth = gainers/list.length*100;
  const health = Math.max(0, Math.min(100, Math.round(breadth*0.7 + (50 + avgChange*10)*0.3)));
  return { gainers, losers, avgChange, health, mostVolatile, topMover };
}

function correlationMatrix() {
  const out = [];
  const syms = SYMBOLS.filter(s=>state[s].history.length>=5);
  for (let i=0;i<syms.length;i++)
    for (let j=i+1;j<syms.length;j++){
      const c = correlation(state[syms[i]].history, state[syms[j]].history);
      if (c!==null) out.push({ a:syms[i], b:syms[j], c });
    }
  return out.sort((x,y)=>Math.abs(y.c)-Math.abs(x.c)).slice(0,6);
}

// ---------------- data fetch (cached + resilient) ----------------
async function fetchQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now()-hit.ts < CACHE_TTL) { metrics.cacheHits++; return hit.data; }

  let data;
  if (API_KEY === "demo") {
    // realistic random walk so the app is demoable without an API key
    const prev = state[symbol].price ?? (80 + Math.random()*320);
    const drift = (Math.random()-0.5) * prev * 0.004;
    const price = +(prev + drift).toFixed(2);
    const prevClose = state[symbol].prevClose ?? +(price*(0.985+Math.random()*0.03)).toFixed(2);
    data = { price, prevClose };
  } else {
    metrics.upstreamCalls++;
    const { data: d } = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`, { timeout: 4500 });
    data = { price: d.c, prevClose: d.pc };
  }
  cache.set(symbol, { data, ts: Date.now() });
  return data;
}

let cursor = 0;                   // round-robin position in SYMBOLS

async function poll() {
  const t0 = Date.now();

  // --- pick the next BATCH symbols in the rotation (rate-limit friendly) ---
  const batch = [];
  for (let i = 0; i < BATCH; i++) {
    batch.push(SYMBOLS[cursor]);
    cursor = (cursor + 1) % SYMBOLS.length;
  }

  await Promise.all(batch.map(async symbol => {
    try {
      const { price, prevClose } = await fetchQuote(symbol);
      if (!price) return;
      const s = state[symbol];
      s.price = price;
      s.prevClose = prevClose;
      s.changePct = prevClose ? +(((price-prevClose)/prevClose)*100).toFixed(2) : 0;
      s.history.push({ t: Date.now(), price });
      if (s.history.length > HISTORY) s.history.shift();
      s.analytics = computeAnalytics(s.history);
      s.updatedAt = Date.now();
    } catch { metrics.errors++; }               // degrade gracefully, keep last good value
  }));

  metrics.lastPollMs = Date.now()-t0;
  metrics.broadcasts++;

  // Broadcast the FULL state every poll, even though only a subset was refreshed —
  // clients always see a complete picture.
  io.emit("tick", {
    stocks: Object.values(state),
    summary: marketSummary(),
    correlations: correlationMatrix(),
    metrics: publicMetrics(),
  });
}

function publicMetrics() {
  const uptime = Math.floor((Date.now()-metrics.startedAt)/1000);
  // fan-out saving: without the broadcast model each client would poll each symbol itself
  const callsSaved = Math.max(0, metrics.broadcasts * SYMBOLS.length * Math.max(0, metrics.clients-1));
  const callsPerMin = Math.round(BATCH * (60000/POLL_MS));
  return { clients: metrics.clients, peakClients: metrics.peakClients,
           broadcasts: metrics.broadcasts, upstreamCalls: metrics.upstreamCalls,
           cacheHits: metrics.cacheHits, callsSaved, errors: metrics.errors,
           lastPollMs: metrics.lastPollMs, uptime, callsPerMin, rateLimit: 30,
           mode: API_KEY==="demo" ? "demo" : "live" };
}

// ---------------- REST ----------------
app.get("/",            (_,res)=> res.json({ status:"ok", symbols:SYMBOLS, mode: API_KEY==="demo"?"demo":"live" }));
app.get("/health",      (_,res)=> res.json({ status:"healthy", uptime: publicMetrics().uptime, errors: metrics.errors }));
app.get("/api/metrics", (_,res)=> res.json(publicMetrics()));
app.get("/api/snapshot",(_,res)=> res.json({ stocks:Object.values(state), summary:marketSummary(),
                                             correlations:correlationMatrix(), metrics:publicMetrics() }));
app.get("/api/history/:symbol", (req,res)=>{
  const s = state[req.params.symbol.toUpperCase()];
  res.json(s ? s.history : []);
});

// ---------------- websocket ----------------
io.on("connection", socket => {
  metrics.clients++;
  metrics.peakClients = Math.max(metrics.peakClients, metrics.clients);
  socket.emit("tick", { stocks:Object.values(state), summary:marketSummary(),
                        correlations:correlationMatrix(), metrics:publicMetrics() });
  socket.on("disconnect", ()=> { metrics.clients = Math.max(0, metrics.clients-1); });
});

httpServer.listen(PORT, ()=>{
  console.log(`MarketPulse backend :${PORT} (mode ${API_KEY==="demo"?"demo":"live"})`);
  poll();
  setInterval(poll, POLL_MS);
});
