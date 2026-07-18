# MarketPulse — Real-Time Market Analytics Engine

A live market-data platform. A Node backend ingests quotes under a strict API rate limit,
computes technical analytics, and **streams them to every connected browser over WebSocket**.
The React dashboard renders live tickers, an interactive price chart, cross-asset correlations,
and — unusually — **the system's own operating metrics**.

**[▶ Live Demo](https://market-pulse-five-sigma.vercel.app/)** · **[Source](https://github.com/grgarnv)**

**Stack:** React (Vite) · Recharts · Node.js · Express · Socket.IO · Render + Vercel

---

## The engineering problem this solves

The naive way to build a market dashboard is to have the browser poll the market API directly.
That breaks immediately at any scale:

- The free market-data tier allows **30 requests per minute**, total
- Tracking 8 symbols means each client alone would consume the entire budget
- Every additional user multiplies the load — 10 users would need 10× the quota

**MarketPulse inverts the flow.** One backend is the sole consumer of the upstream API. It polls
on a controlled schedule, computes analytics, caches results, and **broadcasts to all connected
clients at once**:

```
                    ┌──────────────────────────────────────┐
                    │          Node backend                │
  Market API ──────▶│  • round-robin polling               │──┐
  (30 req/min cap)  │  • in-memory cache (TTL)             │  │  WebSocket
                    │  • analytics engine                  │  │  broadcast
                    │  • self-monitoring metrics           │  │
                    └──────────────────────────────────────┘  │
                                                              ├──▶ Browser 1
                                                              ├──▶ Browser 2
                                                              └──▶ Browser N
```

**Result: N clients cost the same upstream API budget as one.** Adding users adds zero API cost.

### Round-robin polling: staying under the rate limit without feeling slow

Refreshing all 8 symbols every 5 seconds would fire **96 requests/minute** — over 3× the limit.
Slowing the whole dashboard to a 20-second refresh would fix the quota but feel dead.

Instead, each poll refreshes a **rotating subset** of symbols while still broadcasting the full
state to clients:

```js
const POLL_MS = 5000;   // broadcast every 5s
const BATCH   = 2;      // but only refresh 2 symbols per poll

// 2 symbols × 12 polls/min = 24 calls/min  →  safely under the 30 limit
```

Each individual symbol refreshes every 20 seconds, but the client receives an update every 5
seconds and the interface never feels stale. The budget is reported live in the dashboard's
status bar.

---

## Analytics

Computed server-side over a rolling 90-tick window per symbol:

| Metric | Definition |
|---|---|
| **SMA** | Simple moving average over the window |
| **EMA** | Exponential moving average — weights recent prices more heavily |
| **Volatility** | Standard deviation of tick-to-tick percentage returns (comparable across price levels) |
| **Momentum** | Percentage change across the window |
| **Signal** | Bullish / bearish, triggered when price crosses its own moving average |
| **Range** | Window high and low |

**Market-wide:**
- **Market health score (0–100)** — blends breadth (share of symbols advancing) with the average move
- **Most volatile** and **top mover** identification
- **Cross-asset correlation** — Pearson correlation between every symbol pair's price series, ranked by strength, revealing which assets move together

---

## Self-monitoring: the system observes itself

A distinguishing feature — the dashboard displays its own operational telemetry in a live status
strip:

- **Connected clients** (current and peak)
- **Broadcasts sent**
- **API calls saved** by the fan-out architecture
- **Cache hits**
- **Poll latency** in milliseconds
- **Uptime** and **error count**

This makes the architectural advantage *visible* rather than buried in a README — you can watch
the "API calls saved" counter climb as clients connect.

---

## Resilience

The system is built to degrade gracefully rather than fail:

- **WebSocket auto-reconnect** with exponential backoff and infinite retries; the UI shows a
  distinct "Reconnecting…" state rather than silently dying
- **Per-symbol error isolation** — one failed fetch doesn't abort the poll cycle; the last known
  good value is retained
- **In-memory cache with TTL** absorbs repeat requests within the refresh window
- **React error boundary** — a single broken widget can't take down the dashboard
- **Demo mode** — with no API key configured, the backend generates a realistic random walk, so
  the app is fully demoable 24/7 without credentials or market hours
- **Health endpoints** (`/health`, `/api/metrics`) for uptime monitoring

---

## Interface

- Live ticker watchlist with **price-flash animations** (green/red pulse on movement)
- Interactive area chart with an **SMA reference line**; click any symbol to inspect
- Market summary cards including a visual **health bar**
- Cross-asset correlation panel with signed strength bars
- Shimmer **loading skeletons** during connection, responsive down to mobile

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /` | Status, tracked symbols, data mode |
| `GET /health` | Uptime and error count |
| `GET /api/metrics` | Live system telemetry |
| `GET /api/snapshot` | Full current state — stocks, summary, correlations, metrics |
| `GET /api/history/:symbol` | Rolling price history for one symbol |
| `WS tick` | Broadcast payload pushed to all clients every 5s |

---

## Running locally

**Backend**
```bash
cd backend
npm install
cp .env.example .env        # add a free Finnhub key, or leave blank for demo mode
npm start                   # http://localhost:4000
```

**Frontend**
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

> Without an API key the backend runs in **demo mode** with simulated price movement — useful for
> development and for demoing outside market hours.

## Deployment

- **Backend → Render** — Node service, `npm install` / `node server.js`, optional `FINNHUB_API_KEY` env var
- **Frontend → Vercel** — root directory `frontend`, env var `VITE_API_URL` set to the Render backend URL

> US markets trade 9:30am–4pm ET on weekdays. Outside those hours a live API returns the last
> closing price unchanged, so the chart will appear flat — expected behaviour, not a fault.

---

## What I'd build next

- **Redis** for shared state across multiple backend instances, enabling true horizontal scaling
- **Historical candle seeding** on startup so charts load with shape instead of building from empty
- **User accounts** with persisted custom watchlists
- **Price alerts** — server-side threshold monitoring with push notifications
- **Time-series persistence** so history survives restarts on ephemeral hosting
