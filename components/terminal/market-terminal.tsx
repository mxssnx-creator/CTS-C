"use client"

import { useEffect, useRef, useState } from "react"
import { createChart, CandlestickSeries, HistogramSeries, ColorType, type UTCTimestamp } from "lightweight-charts"
import { RefreshCw, Radio } from "lucide-react"
interface MarketCandle { time: number; open: number; high: number; low: number; close: number; volume: number }

export function MarketTerminal({demo=true}:{demo?:boolean}) {
  const element = useRef<HTMLDivElement>(null)
  const [symbol, setSymbol] = useState("BTC-USDT")
  const [interval, setIntervalValue] = useState("5m")
  const [venue, setVenue] = useState("bingx")
  const [environment, setEnvironment] = useState(demo?"demo":"public")
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState("Waiting for market data")
  const [lastClose, setLastClose] = useState<number | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const container = element.current
    if (!container) return
    const chart = createChart(container, {
      autoSize: true, height: 340,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8", attributionLogo: true },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { timeVisible: true, borderVisible: false },
    })
    const series = chart.addSeries(CandlestickSeries, { upColor: "#34d399", downColor: "#fb7185", wickUpColor: "#34d399", wickDownColor: "#fb7185", borderVisible: false })
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } })
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let initialized = false
    let lastTime = 0
    setLastClose(null)
    setStatus("Loading exchange candles…")
    setError(false)
    const poll = async () => {
      try {
        const params = new URLSearchParams({ symbol, interval, exchange: venue, demo: String(environment === "demo") })
        const response = await fetch(`/api/market-data/candles?${params}`, { signal: abort.signal })
        const body = await response.json()
        if (!response.ok || !body.success) throw new Error(body.error || "Market feed unavailable")
        const candles: MarketCandle[] = body.data
        const values = candles.map(c => ({ ...c, time: c.time as UTCTimestamp }))
        const volumes = candles.map(c => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? "rgba(52,211,153,0.25)" : "rgba(251,113,133,0.25)" }))
        if (!initialized) {
          series.setData(values)
          volume.setData(volumes)
          chart.timeScale().fitContent()
          initialized = true
        } else {
          values.filter(c => c.time >= lastTime).forEach(c => series.update(c))
          volumes.filter(c => c.time >= lastTime).forEach(c => volume.update(c))
        }
        lastTime = candles.at(-1)!.time
        setLastClose(candles.at(-1)!.close)
        setStatus(`${body.source} · updated ${new Date(body.receivedAt).toLocaleTimeString()}`)
        setError(false)
      } catch (reason) {
        if (abort.signal.aborted) return
        setStatus(reason instanceof Error ? reason.message : "Market feed unavailable")
        setError(true)
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 15_000)
      }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer); chart.remove() }
  }, [symbol, interval, venue, environment, reload])

  const inputClass = "terminal-input"
  return <section className="terminal-panel terminal-chart" aria-label="Market terminal">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-4">
      <div>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Radio className="h-3 w-3" /> EXCHANGE MARKET FEED</div>
        <div className="flex items-baseline gap-3"><h2 className="font-semibold tracking-tight">{symbol}</h2><span className="font-mono text-lg tabular-nums">{lastClose === null ? "—" : lastClose.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={inputClass} aria-label="Market exchange" value={venue} onChange={e => setVenue(e.target.value)}><option value="bingx">BingX</option><option value="bybit">Bybit</option></select>
        <select className={inputClass} aria-label="Market environment" value={environment} onChange={e => setEnvironment(e.target.value)}><option value="public">Public market</option><option value="demo">Demo market</option></select>
        <select className={inputClass} aria-label="Market symbol" value={symbol} onChange={e => setSymbol(e.target.value)}>{["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "BCH-USDT"].map(s => <option key={s}>{s}</option>)}</select>
        <select className={inputClass} aria-label="Candle interval" value={interval} onChange={e => setIntervalValue(e.target.value)}>{["1m", "5m", "15m", "30m", "1h", "4h", "1d"].map(s => <option key={s}>{s}</option>)}</select>
        <button className="terminal-icon-button" aria-label="Refresh market candles" onClick={() => setReload(v => v + 1)}><RefreshCw className="h-4 w-4" /></button>
      </div>
    </div>
    <div ref={element} className="h-[340px] w-full" role="img" aria-label={`${symbol} candlestick and volume chart`} />
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
      <span role="status" className={error ? "text-destructive" : ""}>{error && lastClose !== null ? "Stale chart · " : ""}{status}</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="hover:text-foreground">TradingView Lightweight Charts™ · Copyright © 2026 TradingView, Inc.</a>
    </div>
  </section>
}
