# MarketPulse — Real-Time Market Analytics Dashboard

A full-stack, real-time stock analytics dashboard. A Node backend polls live market
data, computes analytics, and **streams updates to every connected browser over
WebSocket**; a React dashboard renders live tickers, an interactive price chart, and
computed metrics that update continuously.

**🔗 [Live Demo](#)** · **Stack:** React · Recharts · Node/Express · Socket.IO · deployed on Vercel + Render

![screenshot](screenshot.png)

## The interesting engineering problem

Free stock APIs are **rate-limited** (~60 requests/min), so having every browser call
the API directly doesn't scale. MarketPulse solves this with a **fan-out architecture**:

```
Finnhub API ──poll every 5s──▶ Node backend ──WebSocket broadcast──▶ N browsers
                               (single consumer,        (100 clients cost the
                                computes analytics)      same API budget as 1)
```

The backend is the single source of truth: it polls on a controlled schedule, maintains
a rolling price history per symbol, computes analytics, and pushes each update to all
clients at once. Adding more users adds **zero** API cost.

## Features
- **Live streaming** — prices and metrics update in real time over Socket.IO, no refresh.
- **Computed analytics** — per-symbol simple moving average, volatility (std. dev of the
  rolling window), and trend direction, recomputed every tick.
- **Interactive dashboard** — click any symbol to inspect its live chart; market-wide
  summary cards (gainers / losers / average change).
- **Demo mode** — runs without an API key using a realistic price simulation, so it's
  instantly demoable; drops in real Finnhub data the moment a key is provided.

## Run locally

**Backend**
```bash
cd backend
npm install
cp .env.example .env        # add your free Finnhub key (or leave blank for demo mode)
npm start                   # http://localhost:4000
```

**Frontend**
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

## Deploy (free tiers)
- **Backend → Render:** Node service, `npm install` / `node server.js`, set `FINNHUB_API_KEY`.
- **Frontend → Vercel:** root dir `frontend`, set `VITE_API_URL` to the Render URL.

## What I'd add next
- Redis to share state across multiple backend instances (horizontal scaling)
- User accounts + persisted custom watchlists
- Price-alert notifications when a symbol crosses a threshold
