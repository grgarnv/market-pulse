import { useEffect, useState, useMemo, useRef, Component } from 'react'
import { io } from 'socket.io-client'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine
} from 'recharts'

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000'

/* ---------- error boundary: one broken widget can't kill the dashboard ---------- */
class ErrorBoundary extends Component {
  constructor(p){ super(p); this.state={ err:null } }
  static getDerivedStateFromError(err){ return { err } }
  render(){
    if (this.state.err) return <div className="panel err-panel">
      <h3>Something went wrong</h3><p>{String(this.state.err)}</p>
      <button className="btn" onClick={()=>this.setState({err:null})}>Retry</button></div>
    return this.props.children
  }
}

export default function App() {
  const [data, setData]         = useState(null)     // { stocks, summary, correlations, metrics }
  const [selected, setSelected] = useState('AAPL')
  const [status, setStatus]     = useState('connecting')
  const [flash, setFlash]       = useState({})       // symbol -> 'up' | 'down'
  const prevPrices               = useRef({})

  /* ---------- socket with auto-reconnect + backoff ---------- */
  useEffect(() => {
    const socket = io(API, {
      reconnection: true, reconnectionDelay: 1000,
      reconnectionDelayMax: 8000, reconnectionAttempts: Infinity,
    })
    socket.on('connect',    () => setStatus('live'))
    socket.on('disconnect', () => setStatus('reconnecting'))
    socket.on('connect_error', () => setStatus('reconnecting'))
    socket.on('tick', payload => {
      // flash each ticker green/red when its price moves
      const f = {}
      payload.stocks.forEach(s => {
        const prev = prevPrices.current[s.symbol]
        if (prev != null && s.price !== prev) f[s.symbol] = s.price > prev ? 'up' : 'down'
        prevPrices.current[s.symbol] = s.price
      })
      setFlash(f)
      setTimeout(() => setFlash({}), 700)
      setData(payload)
    })
    return () => socket.close()
  }, [])

  const stocks  = data?.stocks || []
  const summary = data?.summary
  const metrics = data?.metrics
  const active  = stocks.find(s => s.symbol === selected)

  const chartData = useMemo(() => (active?.history || []).map(h => ({
    time: new Date(h.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
    price: h.price,
  })), [active])

  const money = n => n == null ? '—' : `$${Number(n).toFixed(2)}`
  const pct   = n => n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`
  const dur   = s => s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m ${s%60}s` : `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`

  return (
    <ErrorBoundary>
    <div className="app">
      {/* ================= HEADER ================= */}
      <header className="topbar">
        <div className="brand">
          <div className="logo">◐</div>
          <div>
            <h1>MarketPulse</h1>
            <p>Real-time market analytics engine</p>
          </div>
        </div>
        <div className="head-right">
          {metrics && <span className="mode-pill">{metrics.mode === 'live' ? 'LIVE DATA' : 'DEMO MODE'}</span>}
          <div className={`status ${status}`}>
            <span className="dot" />
            {status === 'live' ? 'Streaming' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          </div>
        </div>
      </header>

      {/* ================= SYSTEM STATUS STRIP (the engineering, made visible) ============ */}
      <section className="sysbar">
        <Sys label="Connected clients" value={metrics?.clients ?? '—'} />
        <Sys label="Broadcasts sent"   value={metrics?.broadcasts?.toLocaleString() ?? '—'} />
        <Sys label="API calls saved"   value={metrics?.callsSaved?.toLocaleString() ?? '0'} hint="by fan-out" />
        <Sys label="Cache hits"        value={metrics?.cacheHits?.toLocaleString() ?? '—'} />
        <Sys label="Poll latency"      value={metrics ? `${metrics.lastPollMs}ms` : '—'} />
        <Sys label="Uptime"            value={dur(metrics?.uptime)} />
        <Sys label="Errors"            value={metrics?.errors ?? '—'} tone={metrics?.errors ? 'down' : 'up'} />
      </section>

      {/* ================= MARKET SUMMARY ================= */}
      <section className="cards">
        <Card label="Market health" big={summary ? `${summary.health}` : null} suffix="/100"
              bar={summary?.health} loading={!summary} />
        <Card label="Advancing" big={summary?.gainers} tone="up" loading={!summary}
              sub={summary ? `${summary.losers} declining` : ''} />
        <Card label="Avg change" big={summary ? pct(summary.avgChange) : null} loading={!summary}
              tone={summary?.avgChange >= 0 ? 'up' : 'down'} />
        <Card label="Most volatile" big={summary?.mostVolatile} loading={!summary}
              sub={summary ? `top mover ${summary.topMover}` : ''} />
      </section>

      <div className="main">
        {/* ================= WATCHLIST ================= */}
        <section className="panel">
          <h3>Watchlist</h3>
          <div className="thead"><span>Symbol</span><span>Price</span><span>Change</span></div>
          {!stocks.length && [...Array(8)].map((_,i)=><div key={i} className="skeleton row" />)}
          {stocks.map(s => (
            <button key={s.symbol}
                    className={`ticker ${s.symbol===selected?'sel':''} ${flash[s.symbol]?`flash-${flash[s.symbol]}`:''}`}
                    onClick={()=>setSelected(s.symbol)}>
              <span className="sym">
                <b>{s.symbol}</b>
                <em>{s.name}</em>
              </span>
              <span className="price">{money(s.price)}</span>
              <span className={s.changePct>=0?'up':'down'}>{pct(s.changePct)}</span>
            </button>
          ))}
        </section>

        {/* ================= CHART + ANALYTICS ================= */}
        <section className="panel chartpanel">
          {!active ? <div className="skeleton chart" /> : <>
            <div className="chart-head">
              <div>
                <h2>{active.symbol} <span className="cname">{active.name}</span></h2>
                <div className="bigprice">
                  {money(active.price)}
                  <span className={active.changePct>=0?'up':'down'}> {pct(active.changePct)}</span>
                </div>
              </div>
              <div className={`signal ${active.analytics?.signal}`}>
                {active.analytics?.signal || '—'}
              </div>
            </div>

            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData} margin={{top:8,right:12,left:0,bottom:0}}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#4f46e5" stopOpacity={0.30}/>
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" vertical={false}/>
                <XAxis dataKey="time" tick={{fontSize:11,fill:'#94a3b8'}} minTickGap={50} tickLine={false} axisLine={false}/>
                <YAxis domain={['auto','auto']} tick={{fontSize:11,fill:'#94a3b8'}} width={58} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{borderRadius:10,border:'1px solid #e5e9f0',fontSize:13}}
                         formatter={v=>[money(v),'Price']}/>
                {active.analytics?.sma &&
                  <ReferenceLine y={active.analytics.sma} stroke="#f59e0b" strokeDasharray="4 4"
                                 label={{value:'SMA',position:'right',fontSize:10,fill:'#f59e0b'}}/>}
                <Area type="monotone" dataKey="price" stroke="#4f46e5" strokeWidth={2}
                      fill="url(#g)" isAnimationActive={false}/>
              </AreaChart>
            </ResponsiveContainer>

            <div className="analytics">
              <M k="SMA"        v={money(active.analytics?.sma)} />
              <M k="EMA"        v={money(active.analytics?.ema)} />
              <M k="Volatility" v={active.analytics?.volatility ?? '—'} />
              <M k="Momentum"   v={pct(active.analytics?.momentum)}
                 tone={active.analytics?.momentum>=0?'up':'down'} />
              <M k="Range"      v={`${money(active.analytics?.low)} – ${money(active.analytics?.high)}`} />
            </div>
          </>}
        </section>
      </div>

      {/* ================= CROSS-ASSET CORRELATIONS ================= */}
      <section className="panel corr">
        <h3>Cross-asset correlation <span className="sub">strongest relationships in the current window</span></h3>
        <div className="corrgrid">
          {!data?.correlations?.length && <p className="hint">Building correlation window…</p>}
          {data?.correlations?.map(c => (
            <div key={c.a+c.b} className="corritem">
              <span className="pair">{c.a} · {c.b}</span>
              <div className="corrbar">
                <div className={`fill ${c.c>=0?'pos':'neg'}`} style={{width:`${Math.abs(c.c)*100}%`}} />
              </div>
              <span className={`cval ${c.c>=0?'up':'down'}`}>{c.c>0?'+':''}{c.c}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="foot">
        Single backend polls the rate-limited market API, computes analytics, and broadcasts
        to every client over WebSocket — N clients cost the same upstream budget as one.
      </footer>
    </div>
    </ErrorBoundary>
  )
}

/* ---------- small presentational components ---------- */
function Sys({ label, value, hint, tone }) {
  return <div className="sysitem">
    <span className="syslabel">{label}{hint && <i> {hint}</i>}</span>
    <span className={`sysvalue ${tone||''}`}>{value}</span>
  </div>
}
function Card({ label, big, sub, suffix, tone, bar, loading }) {
  return <div className="card">
    <span className="clabel">{label}</span>
    {loading ? <div className="skeleton line" /> : <>
      <span className={`cvalue ${tone||''}`}>{big ?? '—'}{suffix && <small>{suffix}</small>}</span>
      {bar != null && <div className="healthbar"><div style={{width:`${bar}%`}}
        className={bar>60?'hb-up':bar<40?'hb-down':'hb-mid'} /></div>}
      {sub && <span className="csub">{sub}</span>}
    </>}
  </div>
}
function M({ k, v, tone }) {
  return <div className="metric"><span className="mk">{k}</span><span className={`mv ${tone||''}`}>{v}</span></div>
}
