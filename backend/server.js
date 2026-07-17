/**
 * MarketPulse backend — live stock analytics engine.
 *
 * ARCHITECTURE (the interesting part to explain in an interview):
 *   Free stock APIs are rate-limited hard. So instead of every browser hitting
 *   the API, ONE backend polls Finnhub on a schedule, computes analytics, and
 *   fans the results out to all connected clients over WebSocket. 100 clients
 *   cost the same API budget as 1. The backend is the single source of truth.
 */
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.FINNHUB_API_KEY || "demo";
const PORT = process.env.PORT || 4000;
const POLL_MS = 5000;                 // refresh every 5s (well under 60 req/min)

// The universe of symbols we track. Kept small to respect rate limits.
const SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META", "JPM"];

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ---- In-memory state: latest quote + rolling price history per symbol ----
const state = {};   // symbol -> { price, prevClose, changePct, history: [...] }
SYMBOLS.forEach(s => { state[s] = { symbol: s, price: null, prevClose: null,
                                    changePct: null, history: [] }; });

// ---- Compute analytics from a rolling price window ----
function analytics(history) {
  if (history.length < 2) return { sma: null, volatility: null, trend: "flat" };
  const prices = history.map(h => h.price);
  const sma = prices.reduce((a, b) => a + b, 0) / prices.length;         // moving avg
  const mean = sma;
  const variance = prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length;
  const volatility = Math.sqrt(variance);                                // std dev
  const trend = prices[prices.length - 1] > prices[0] ? "up"
              : prices[prices.length - 1] < prices[0] ? "down" : "flat";
  return { sma: +sma.toFixed(2), volatility: +volatility.toFixed(3), trend };
}

// ---- Fetch one symbol's quote from Finnhub (or synthesize if using demo key) ----
async function fetchQuote(symbol) {
  if (API_KEY === "demo") {
    // deterministic-ish random walk so the app is demoable WITHOUT a key
    const prev = state[symbol].price || 100 + Math.random() * 300;
    const price = +(prev + (Math.random() - 0.5) * 2).toFixed(2);
    const prevClose = state[symbol].prevClose || +(price * 0.99).toFixed(2);
    return { price, prevClose };
  }
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`;
  const { data } = await axios.get(url, { timeout: 4000 });
  return { price: data.c, prevClose: data.pc };   // c = current, pc = prev close
}

// ---- The polling loop: refresh all symbols, compute, broadcast ----
async function poll() {
  await Promise.all(SYMBOLS.map(async (symbol) => {
    try {
      const { price, prevClose } = await fetchQuote(symbol);
      if (!price) return;
      const s = state[symbol];
      s.price = price;
      s.prevClose = prevClose;
      s.changePct = prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;
      s.history.push({ t: Date.now(), price });
      if (s.history.length > 60) s.history.shift();     // keep last 60 ticks
      s.analytics = analytics(s.history);
    } catch (e) {
      // rate-limited or network blip — skip this symbol this round
    }
  }));
  io.emit("tick", Object.values(state));               // fan out to all clients
}

// ---- REST endpoints ----
app.get("/", (_, res) => res.json({ status: "ok", symbols: SYMBOLS, mode: API_KEY === "demo" ? "demo" : "live" }));
app.get("/api/snapshot", (_, res) => res.json(Object.values(state)));
app.get("/api/history/:symbol", (req, res) => {
  const s = state[req.params.symbol.toUpperCase()];
  res.json(s ? s.history : []);
});

// ---- WebSocket: send current snapshot immediately on connect ----
io.on("connection", (socket) => {
  socket.emit("tick", Object.values(state));
});

httpServer.listen(PORT, () => {
  console.log(`MarketPulse backend on :${PORT} (mode: ${API_KEY === "demo" ? "demo" : "live"})`);
  poll();                          // first poll immediately
  setInterval(poll, POLL_MS);      // then every POLL_MS
});
