import { useEffect, useState, useMemo } from 'react'
import { io } from 'socket.io-client'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'

// Backend URL — localhost in dev, set VITE_API_URL in production (Render URL).
const API = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export default function App() {
  const [stocks, setStocks] = useState([])        // live data for all symbols
  const [selected, setSelected] = useState('AAPL') // which symbol's chart to show
  const [connected, setConnected] = useState(false)

  // --- open ONE websocket, receive live ticks, update state ---
  useEffect(() => {
    const socket = io(API)
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('tick', data => setStocks(data))     // server pushes all symbols each tick
    return () => socket.close()                     // clean up on unmount
  }, [])

  const active = stocks.find(s => s.symbol === selected)

  // chart data for the selected symbol
  const chartData = useMemo(
    () => (active?.history || []).map(h => ({
      time: new Date(h.t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
      price: h.price,
    })), [active])

  // market-wide summary metrics
  const summary = useMemo(() => {
    if (!stocks.length) return { gainers: 0, losers: 0, avgChange: 0 }
    const gainers = stocks.filter(s => s.changePct > 0).length
    const losers = stocks.filter(s => s.changePct < 0).length
    const avgChange = stocks.reduce((a, s) => a + (s.changePct || 0), 0) / stocks.length
    return { gainers, losers, avgChange: avgChange.toFixed(2) }
  }, [stocks])

  const fmt = n => (n == null ? '—' : `$${n.toFixed(2)}`)
  const pct = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◐</span>
          <div>
            <h1>MarketPulse</h1>
            <p>Real-time market analytics</p>
          </div>
        </div>
        <div className={`status ${connected ? 'live' : 'off'}`}>
          <span className="dot" /> {connected ? 'LIVE' : 'connecting…'}
        </div>
      </header>

      {/* market summary cards */}
      <section className="cards">
        <Card label="Symbols tracked" value={stocks.length} />
        <Card label="Gainers" value={summary.gainers} tone="up" />
        <Card label="Losers" value={summary.losers} tone="down" />
        <Card label="Avg change" value={pct(+summary.avgChange)}
              tone={summary.avgChange > 0 ? 'up' : 'down'} />
      </section>

      <div className="main">
        {/* ticker list */}
        <section className="panel tickers">
          <h3>Watchlist</h3>
          <div className="thead"><span>Symbol</span><span>Price</span><span>Change</span></div>
          {stocks.map(s => (
            <button key={s.symbol}
                    className={`ticker ${s.symbol === selected ? 'sel' : ''}`}
                    onClick={() => setSelected(s.symbol)}>
              <span className="sym">{s.symbol}</span>
              <span className="price">{fmt(s.price)}</span>
              <span className={s.changePct >= 0 ? 'up' : 'down'}>{pct(s.changePct)}</span>
            </button>
          ))}
        </section>

        {/* chart + analytics for selected symbol */}
        <section className="panel chartpanel">
          <div className="chart-head">
            <div>
              <h2>{selected} <span className={active?.changePct >= 0 ? 'up' : 'down'}>
                {fmt(active?.price)} {pct(active?.changePct)}</span></h2>
            </div>
            {active?.analytics && (
              <div className="analytics">
                <Metric k="SMA" v={fmt(active.analytics.sma)} />
                <Metric k="Volatility" v={active.analytics.volatility ?? '—'} />
                <Metric k="Trend" v={active.analytics.trend}
                        tone={active.analytics.trend === 'up' ? 'up'
                            : active.analytics.trend === 'down' ? 'down' : ''} />
              </div>
            )}
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
              <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#94a3b8' }} minTickGap={40} />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#94a3b8' }} width={55} />
              <Tooltip />
              <Line type="monotone" dataKey="price" stroke="#4f46e5" strokeWidth={2}
                    dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <p className="hint">Live updates stream over WebSocket every 5s · click any symbol to inspect</p>
        </section>
      </div>
    </div>
  )
}

function Card({ label, value, tone }) {
  return <div className="card"><span className="clabel">{label}</span>
    <span className={`cvalue ${tone || ''}`}>{value}</span></div>
}
function Metric({ k, v, tone }) {
  return <div className="metric"><span className="mk">{k}</span>
    <span className={`mv ${tone || ''}`}>{v}</span></div>
}
