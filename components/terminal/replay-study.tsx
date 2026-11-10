"use client"

import { useMemo, useState } from "react"
import { Download, FlaskConical, Play } from "lucide-react"
import { formatProfitFactor, profitFactorRank, type ProfitFactorState } from "./profit-factor"

type ReplayMetrics = { trades: number; pf: number | null; pfState?: ProfitFactorState; netReturnSumPct: number; maxDrawdownPct: number; winRate: number; long: number; short: number; open: number }
type ReplayRow = { id: string; range: string; tactic: string; tpStep: number; slRatio: number; exitMode: string; training: ReplayMetrics; trainingPassed: boolean; holdout: ReplayMetrics }
type ReplayResult = { success: boolean; source: string; createdAt: string | number; configurations: number; enoughSamples: number; samplesPercent: number; eligible: number; minSamples?: number; minPf?: number; trainingCandles: number; holdoutCandles: number; rows: ReplayRow[]; executionEligible: false; note: string }
const decimal = (value: number | null | undefined, places = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(places) : "—"
const stat = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—"

export function ReplayStudy() {
  const [symbol, setSymbol] = useState("BTC-USDT")
  const [interval, setInterval] = useState("5m")
  const [exchange, setExchange] = useState<"bingx" | "bybit">("bingx")
  const [demo, setDemo] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [range, setRange] = useState("all")
  const [tactic, setTactic] = useState("all")
  const [qualifiedOnly, setQualifiedOnly] = useState(false)
  const [page, setPage] = useState(0)
  const [runIdentity, setRunIdentity] = useState<string | null>(null)
  const filtered = useMemo(() => (result?.rows ?? []).filter(row =>
    (range === "all" || row.range === range) && (tactic === "all" || row.tactic === tactic) && (!qualifiedOnly || row.trainingPassed)
  ).sort((a, b) => Number(b.trainingPassed) - Number(a.trainingPassed) || profitFactorRank(b.training.pf, b.training.pfState) - profitFactorRank(a.training.pf, a.training.pfState) || a.id.localeCompare(b.id)), [result, range, tactic, qualifiedOnly])
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25))
  const visible = filtered.slice(page * 25, (page + 1) * 25)
  const run = async (event: React.FormEvent) => {
    event.preventDefault()
    if (running) return
    const normalized = symbol.trim().toUpperCase()
    if (!/^[A-Z0-9]{2,20}-USDT$/.test(normalized)) { setError("Use a symbol such as BTC-USDT."); return }
    setRunning(true); setError(null)
    try {
      const response = await fetch("/api/terminal/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: normalized, interval, exchange, demo }) })
      const body = await response.json()
      if (!response.ok || body.success !== true || !Array.isArray(body.rows)) throw new Error(body.error || "Replay did not return a valid result.")
      setResult(body as ReplayResult); setRunIdentity(`${normalized} · ${interval} · ${exchange}${demo ? " demo" : " public"}`)
      setRange("all"); setTactic("all"); setQualifiedOnly(false); setPage(0)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Replay request failed.") }
    finally { setRunning(false) }
  }
  const download = () => {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url; anchor.download = `cts-c-replay-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section className="terminal-panel mt-5 space-y-5 p-5" aria-labelledby="replay-heading">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="terminal-muted text-[10px] uppercase tracking-[.2em]">Research / Forward validation</p><h2 id="replay-heading" className="mt-1 flex items-center gap-2 text-xl font-semibold"><FlaskConical className="h-5 w-5 text-[var(--terminal-accent)]" />Historical replay study</h2><p className="terminal-muted mt-2 max-w-3xl text-xs leading-relaxed">Evaluate configurations on downloaded market candles, then inspect a separate holdout period. This study does not place orders or qualify configurations for live execution.</p></div>{result && <button type="button" className="terminal-button" onClick={download}><Download className="mr-2 inline h-4 w-4" />Export JSON</button>}</div>
      <form onSubmit={run}>
        <fieldset disabled={running} className="flex min-w-0 flex-wrap items-end gap-3">
          <label className="space-y-2 text-xs"><span className="terminal-muted block">Symbol</span><input className="terminal-input w-36" value={symbol} onChange={event => setSymbol(event.target.value)} required placeholder="BTC-USDT" /></label>
          <label className="space-y-2 text-xs"><span className="terminal-muted block">Candle interval</span><select className="terminal-input" value={interval} onChange={event => setInterval(event.target.value)}>{["1m", "5m", "15m", "1h"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="space-y-2 text-xs"><span className="terminal-muted block">Market source</span><select className="terminal-input" value={exchange} onChange={event => { const value = event.target.value as "bingx" | "bybit"; setExchange(value); if (value === "bybit") setDemo(false) }}><option value="bingx">BingX</option><option value="bybit">Bybit</option></select></label>
          <label className="flex h-10 items-center gap-2 text-xs terminal-muted"><input type="checkbox" className="accent-cyan-400" checked={demo} disabled={exchange !== "bingx"} onChange={event => setDemo(event.target.checked)} />VST demo market feed</label>
          <button type="submit" className="terminal-button border-violet-400/40 bg-violet-400/10 text-[var(--terminal-accent)]" disabled={running}><Play className="mr-2 inline h-4 w-4" />{running ? "Running replay…" : "Run replay"}</button>
        </fieldset>
      </form>
      {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-[var(--terminal-red)]">{error}{result ? " The previous result remains visible below." : ""}</p>}
      {running && <p role="status" className="terminal-muted text-xs">Fetching candles and evaluating training and holdout periods…</p>}
      {!result ? <div className="rounded-lg border border-dashed border-[var(--terminal-border)] p-8 text-center"><FlaskConical className="mx-auto mb-3 h-7 w-7 terminal-muted" /><p className="text-sm">No replay results yet</p><p className="terminal-muted mt-1 text-xs">Choose a market and run a study to see measured results here.</p></div> : <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-mono text-[var(--terminal-blue)]">{runIdentity}</span><span className="terminal-muted">{result.source} · {Number.isNaN(new Date(result.createdAt).getTime()) ? String(result.createdAt) : new Date(result.createdAt).toLocaleString()}</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
          ["Configurations", stat(result.configurations), "Evaluated in this study"],
          ["Enough samples", `${decimal(result.samplesPercent, 1)}%`, `${stat(result.enoughSamples)} configurations`],
          ["Training qualified", stat(result.eligible), "Holdout remains independent"],
          ["Candles", `${stat(result.trainingCandles)} / ${stat(result.holdoutCandles)}`, "Training / holdout"],
        ].map(([label, value, description]) => <div key={label} className="rounded-lg border border-[var(--terminal-border)] p-4"><p className="terminal-muted text-[10px] uppercase tracking-wider">{label}</p><p className="mt-2 font-mono text-2xl">{value}</p><p className="terminal-muted mt-1 text-[11px]">{description}</p></div>)}</div>
        <p className="terminal-muted text-xs leading-relaxed">{result.note}</p>
        <p className="terminal-muted text-xs leading-relaxed">The table contains a training-ranked shortlist of up to three configurations per range, evaluated separately on holdout candles.{result.minSamples !== undefined && result.minPf !== undefined ? ` Training gate: at least ${result.minSamples} completed samples and PF ${decimal(result.minPf)}.` : ""}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 terminal-muted">Range<select className="terminal-input" value={range} onChange={event => { setRange(event.target.value); setPage(0) }}><option value="all">All ranges</option>{[...new Set(result.rows.map(row => row.range))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="flex items-center gap-2 terminal-muted">Tactic<select className="terminal-input" value={tactic} onChange={event => { setTactic(event.target.value); setPage(0) }}><option value="all">All tactics</option>{[...new Set(result.rows.map(row => row.tactic))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="flex items-center gap-2 terminal-muted"><input type="checkbox" className="accent-cyan-400" checked={qualifiedOnly} onChange={event => { setQualifiedOnly(event.target.checked); setPage(0) }} />Training-qualified only</label>
          <span className="terminal-muted ml-auto">Ranked by training qualification, then training PF</span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-[var(--terminal-border)]">
          <table className="w-full min-w-[950px] text-left text-xs"><thead className="border-b border-[var(--terminal-border)] bg-[var(--terminal-raised)] terminal-muted"><tr><th scope="col" rowSpan={2} className="px-3 py-3">Configuration</th><th scope="colgroup" colSpan={4} className="border-l border-[var(--terminal-border)] px-3 py-2 text-center text-[var(--terminal-accent)]">Training</th><th scope="colgroup" colSpan={4} className="border-l border-[var(--terminal-border)] px-3 py-2 text-center text-[var(--terminal-blue)]">Holdout</th></tr><tr>{["Trades / L:S", "PF", "Net Σ%", "Max DD%", "Trades / L:S", "PF", "Net Σ%", "Max DD%"].map((title, index) => <th scope="col" key={index} className={`px-3 pb-3 text-right font-medium ${index === 0 || index === 4 ? "border-l border-[var(--terminal-border)]" : ""}`}>{title}</th>)}</tr></thead><tbody>{visible.map(row => <tr key={row.id} className="border-b border-[var(--terminal-border)] last:border-0"><td className="px-3 py-3"><div className="font-medium">{row.range} · {row.tactic.replaceAll("_", " ")}</div><div className="terminal-muted mt-1 font-mono text-[10px]">TP {row.tpStep} · SL {decimal(row.slRatio, 1)}× · {row.exitMode}</div><span className={`mt-1 inline-block text-[10px] ${row.trainingPassed ? "text-[var(--terminal-green)]" : "terminal-muted"}`}>{row.trainingPassed ? "Training qualified" : "Training below gate"}</span></td>{[row.training, row.holdout].map((metrics, index) => <MetricsCells key={index} metrics={metrics} />)}</tr>)}</tbody></table>
          {visible.length === 0 && <p className="terminal-muted p-6 text-center text-sm">No configurations match these filters.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><p className="terminal-muted">{filtered.length.toLocaleString()} matching rows · net Σ% is the sum of net trade returns, not account equity.</p><div className="flex items-center gap-3"><button type="button" className="terminal-button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span className="terminal-muted">{page + 1} / {pageCount}</span><button type="button" className="terminal-button" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next</button></div></div>
      </>}
    </section>
  )
}
function MetricsCells({ metrics }: { metrics: ReplayMetrics }) {
  return <><td className="border-l border-[var(--terminal-border)] px-3 py-3 text-right font-mono">{stat(metrics.trades)}<span className="terminal-muted block text-[10px]">{stat(metrics.long)}:{stat(metrics.short)}</span></td><td className="px-3 py-3 text-right font-mono">{formatProfitFactor(metrics.pf, metrics.pfState, 2)}</td><td className={`px-3 py-3 text-right font-mono ${metrics.netReturnSumPct < 0 ? "text-[var(--terminal-red)]" : "text-[var(--terminal-green)]"}`}>{decimal(metrics.netReturnSumPct)}</td><td className="px-3 py-3 text-right font-mono text-[var(--terminal-amber)]">{decimal(metrics.maxDrawdownPct)}</td></>
}
