"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import dynamic from "next/dynamic"
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Check, ChevronRight, CircleDot, ClipboardList, Download, Filter, Layers, LayoutDashboard, ListFilter, Pause, Play, Plug, Radio, RefreshCw, ScanLine, Search, Settings2, ShieldCheck, SlidersHorizontal, TerminalSquare, Workflow, X, Zap } from "lucide-react"
import { ThemeSwitcher, StyleSwitcher } from "./appearance"
import { useTerminalSession } from "./session"
import { formatProfitFactor, type ProfitFactorState } from "./profit-factor"
import {CONNECTIONS,connectionInfo,type ConnectionId} from "@/core/connections"
import type {CoordinationRow} from "./strategy-lab"
import type { ExecutionSnapshot } from "./execution-ledger"
import { ProgressionDetails, PaperEquity, type StageTelemetry } from "./progression-panel"
const ExecutionLedger = dynamic(() => import("./execution-ledger").then(module => module.ExecutionLedger))
const MarketTerminal = dynamic(() => import("./market-terminal").then(module => module.MarketTerminal), { loading: () => <div className="terminal-empty">Loading candle chart…</div> })
const StrategyLab = dynamic(() => import("./strategy-lab").then(module => module.StrategyLab), { loading: () => <div className="terminal-empty">Loading strategy controls…</div> })
const IntegrationsPanel = dynamic(() => import("./integrations-panel").then(module => module.IntegrationsPanel), { loading: () => <div className="terminal-empty">Loading integration inventory…</div> })

type Stage = StageTelemetry
interface Connection { id: string; name: string; exchange: string; demo: boolean; configured: boolean; enabled: boolean; liveEnabled: boolean }
interface Position { id: string; connectionId: string; symbol: string; direction: string; entryPrice: number; quantity: number; status: string; unrealizedPnl: number | null; realizedPnl: number; fee: number; createdAt: string | number | null; closedAt: string | number | null; source?: string }
interface EventItem { timestamp: string; level: string; phase: string; message: string; connectionId: string }
interface Snapshot { connectionId?:ConnectionId;coordinationStats?:CoordinationRow[];updatedAt: number; connections: Connection[]; equity: number | null; paperEquity?: number; positionCount?: number; positionDisplayLimit?: number; realizedPnl: number; fees: number|null;paperTotals?:{closed:number;wins:number;winRate:number|null;longOpen:number;shortOpen:number};engine?:{symbolFees?:Record<string,{makerFeePct:number;takerFeePct:number}>;equityHistory:{equity:number}[]}; openPositions: Position[]; closedPositions: Position[]; stages: Record<string, Stage>; events: EventItem[]; settings: Record<string, string>; readiness: { configured?:boolean;environment?:string;x02Configured: boolean; status: string; engineStatus: string }; metricScope?: string; execution?: ExecutionSnapshot }
type View = "terminal" | "strategies" | "positions" | "activity" | "connections" | "integrations"
const NAV = [
  { id: "terminal", label: "Command center", icon: LayoutDashboard }, { id: "strategies", label: "Strategy lab", icon: SlidersHorizontal },
  { id: "positions", label: "Positions", icon: Layers }, { id: "activity", label: "Activity", icon: TerminalSquare }, { id: "connections", label: "Connections", icon: Plug }, { id: "integrations", label: "Integrations", icon: Workflow },
] as const
const EMPTY_STAGE: Stage = { sets: 0, eligible: 0, enoughSamples: null, samplesPercent: null, pf: null, pfState: "empty" }
const money = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)
const count = (value: number | undefined) => value == null ? "—" : value.toLocaleString()
function Panel({ title, kicker, action, children, className = "" }: { title: string; kicker?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`terminal-panel ${className}`}><header className="terminal-panel-heading"><div>{kicker && <p className="terminal-kicker">{kicker}</p>}<h2>{title}</h2></div>{action}</header>{children}</section>
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="terminal-empty"><span className="terminal-empty-symbol"><ScanLine size={24} /></span><p>{children}</p></div>
}
function SampleGauge({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value))
  return <div className="terminal-gauge" role="img" aria-label={value === null ? "Sample sufficiency not yet reported" : `${pct.toFixed(1)} percent of Base sets have enough samples`}>
    <svg viewBox="0 0 140 140" aria-hidden="true"><circle className="terminal-gauge-track" cx="70" cy="70" r="58" /><circle className="terminal-gauge-fill" cx="70" cy="70" r="58" strokeDasharray={`${pct * 3.644} 364.4`} /></svg>
    <div><strong>{value === null ? "—" : `${pct.toFixed(0)}%`}</strong><span>sample readiness</span></div>
  </div>
}
function MarketTape({demo}:{demo:boolean}) {
  const [quotes, setQuotes] = useState<Record<string, { price: number }>>({})
  const [error, setError] = useState(false)
  const symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BCH-USDT"]
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function update() {
      try {
        if (document.hidden) return
        const response = await fetch("/api/market-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BCH-USDT"], exchange: "bingx", demo }), signal: abort.signal })
        const body = await response.json()
        if (!response.ok || !body.success) throw new Error("No feed")
        setQuotes(body.data); setError(false)
      } catch { if (!abort.signal.aborted) setError(true) }
      finally { if (!abort.signal.aborted) timer = setTimeout(update, 15_000) }
    }
    void update()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [demo])
  return <div className="terminal-tape" aria-label="Public market quotes"><div className="terminal-tape-label"><Radio size={14} /><span>MARKET TAPE<small>{error ? "feed unavailable · last quotes" : `${demo?"BingX VST":"BingX mainnet"} · public prices`}</small></span></div>{symbols.map(symbol => <div className="terminal-ticker" key={symbol}><span>{symbol.replace("-USDT", "")}<small>/ USDT</small></span><strong>{quotes[symbol] ? money(quotes[symbol].price) : "—"}</strong></div>)}</div>
}

function Positions({ open, closed, compact = false, openTotal = open.length }: { open: Position[]; closed: Position[]; compact?: boolean; openTotal?: number }) {
  const [show, setShow] = useState("open")
  const [query, setQuery] = useState("")
  const rows = (show === "open" ? open : closed).filter(p => `${p.symbol} ${p.connectionId} ${p.direction}`.toLowerCase().includes(query.toLowerCase()))
  return <Panel title="Position ledger" kicker="POSITIONS / SOURCE-LABELED LEDGER" action={<div className="terminal-segments"><button className={show === "open" ? "active" : ""} onClick={() => setShow("open")}>Open <span>{openTotal}</span></button><button className={show === "closed" ? "active" : ""} onClick={() => setShow("closed")}>Closed <span>{closed.length}</span></button></div>}>
    {openTotal > open.length && <p className="terminal-ledger-note">Showing {open.length.toLocaleString()} of {openTotal.toLocaleString()} paper open positions in this snapshot. Filters apply to the displayed rows.</p>}
    {!compact && <div className="terminal-table-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter symbol, connection, direction" aria-label="Filter positions" /></div>}
    {rows.length === 0 ? <Empty>{show === "open" ? "No open paper positions in the current snapshot." : "No closed positions recorded yet."}</Empty> : <div className="terminal-table-wrap"><table className="terminal-table"><thead><tr><th>Market</th><th>Direction</th><th>Entry</th><th>Quantity</th><th>{show === "open" ? "Unrealized P&L" : "Realized P&L"}</th><th>Fees</th><th>Source / status</th></tr></thead><tbody>{rows.slice(0, compact ? 5 : 1000).map(row => <tr key={`${row.connectionId}:${row.id}`}><td><strong>{row.symbol}</strong><small>{row.connectionId}</small></td><td><span className={`terminal-tag ${row.direction.toLowerCase() === "long" ? "positive" : "negative"}`}>{row.direction}</span></td><td>{money(row.entryPrice)}</td><td>{row.quantity.toLocaleString()}</td><td className={(show === "open" ? row.unrealizedPnl ?? 0 : row.realizedPnl) >= 0 ? "terminal-positive" : "terminal-negative"}>{money(show === "open" ? row.unrealizedPnl : row.realizedPnl)}</td><td>{money(row.fee)}</td><td><span className="terminal-tag">{row.source || "Unreported"}</span><small>{row.status}</small></td></tr>)}</tbody></table></div>}
  </Panel>
}
function EventLog({ events, full = false }: { events: EventItem[]; full?: boolean }) {
  const [level, setLevel] = useState("all")
  const [query, setQuery] = useState("")
  const filtered = events.filter(event => (level === "all" || event.level === level) && `${event.message} ${event.phase} ${event.connectionId}`.toLowerCase().includes(query.toLowerCase()))
  const exportEvents = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" }))
    const link = document.createElement("a"); link.href = url; link.download = "cts-c-events.json"; link.click(); URL.revokeObjectURL(url)
  }
  return <Panel title="Event stream" kicker="LOGGER / PERSISTED EVENTS" action={full ? <button className="terminal-button subtle" onClick={exportEvents}><Download size={14} /> Export JSON</button> : <span className="terminal-tag">{events.length} records</span>}>
    {full && <div className="terminal-table-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search events" aria-label="Search events" /><select value={level} onChange={e => setLevel(e.target.value)} aria-label="Event level"><option value="all">All levels</option>{[...new Set(events.map(e => e.level))].map(value => <option key={value}>{value}</option>)}</select></div>}
    <div className={`terminal-event-list ${full ? "expanded" : ""}`} aria-live="off">{filtered.length ? filtered.slice(0, full ? 100 : 8).map((event, i) => <div className="terminal-event" key={`${event.timestamp}:${i}`}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><span className={`terminal-event-level ${event.level === "error" ? "terminal-negative" : "terminal-positive"}`}>{event.phase || event.level}</span><p>{event.message}</p></div>) : <Empty>No recorded events. Activity appears here as the engine processes data.</Empty>}</div>
  </Panel>
}

export function TradingTerminal() {
  const { logout } = useTerminalSession()
  const [connectionId,setConnectionId]=useState<ConnectionId>("bingx-x02")
  const selectedConnection=connectionInfo(connectionId),connectionName=selectedConnection.name.toLowerCase()
  const [view, setView] = useState<View>("terminal")
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const requestSequence=useRef(0)
  const refresh = useCallback(async (force=false) => {
    if (inFlight.current&&!force) return
    if(force)controller.current?.abort()
    const sequence=++requestSequence.current
    inFlight.current = true
    const abort=new AbortController();controller.current=abort
    try {
      const response = await fetch(`/api/terminal?connection=${connectionId}`, { cache: "no-store", signal: abort.signal })
      const body = await response.json()
      if (response.status === 401) window.dispatchEvent(new Event("cts-session-expired"))
      if (!response.ok) throw new Error(body.error || "Terminal snapshot unavailable")
      if (mounted.current&&sequence===requestSequence.current) { setSnapshot(body); setError("") }
    } catch (reason) { if (mounted.current&&!abort.signal.aborted&&sequence===requestSequence.current) setError(reason instanceof Error ? reason.message : "Connection unavailable") }
    finally { if(sequence===requestSequence.current)inFlight.current = false }
  }, [connectionId])
  useEffect(() => {
    setSnapshot(null);setNotice("");setError("");inFlight.current=false
    mounted.current = true
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 5000)
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener("visibilitychange", visible)
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); controller.current?.abort() }
  }, [refresh])
  const execute = async (action: string, settings?: Record<string, unknown>) => {
    setBusy(true); setNotice("")
    controller.current?.abort();requestSequence.current++;inFlight.current=false
    try {
      const response = await fetch("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, settings,connectionId }) })
      const body = await response.json()
      if (response.status === 401) window.dispatchEvent(new Event("cts-session-expired"))
      if (!response.ok || !body.success) throw new Error(body.error || "Action failed")
      setNotice(body.message || (action === "save-settings" ? "Strategy configuration saved." : "Connection state updated."))
      await refresh(true)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Action failed"); throw reason }
    finally { setBusy(false) }
  }
  const action = (name: string) => { void execute(name).catch(() => {}) }
  const base = snapshot?.stages.base ?? EMPTY_STAGE
  const open = snapshot?.openPositions ?? []
  const closed = snapshot?.closedPositions ?? []
  const events = snapshot?.events ?? []
  const running = snapshot?.readiness.engineStatus === "running"
  const activeConnection = snapshot?.connections.find(c => c.id === connectionId)
  const liveEnabled = activeConnection?.liveEnabled === true
  const ready = snapshot?.readiness.configured === true
  const settings = snapshot?.settings ?? {}
  const winCount = closed.filter(p => p.realizedPnl > 0).length
  const modules = [
    { title: "SCOUT", sub: "Market discovery", icon: ScanLine, color: "cyan", metric: snapshot ? `${count(base.sets)} Base sets` : "Awaiting snapshot", view: "terminal" as View },
    { title: "FILTER", sub: "Independent stage gates", icon: Filter, color: "rose", metric: snapshot ? `${count(base.eligible)} Base eligible` : "Awaiting snapshot", view: "strategies" as View },
    { title: "ANALYST", sub: "Sample & PF validation", icon: BarChart3, color: "violet", metric: `Cumulative PF ${formatProfitFactor(base.pf, base.pfState)}`, view: "strategies" as View },
    { title: "EXECUTOR", sub: "Exchange order lifecycle", icon: Zap, color: "green", metric: snapshot?.execution ? `${snapshot.execution.summary.ownedLots} owned exchange lots` : "Awaiting exchange ledger", view: "positions" as View },
    { title: "RISK", sub: "Stops, costs & ownership", icon: ShieldCheck, color: "amber", metric: `${selectedConnection.name} entries ${liveEnabled?"enabled":"paused"}`, view: "connections" as View },
    { title: "LOGGER", sub: "Persistent activity trail", icon: ClipboardList, color: "blue", metric: `${events.length} recorded events`, view: "activity" as View },
  ]
  const rules = [
    ["Selected connection configured", ready ? "Ready" : "Missing credentials", ready],
    ["Execution environment", `${selectedConnection.name} / ${selectedConnection.environment}`, true],
    ["Base PF threshold", settings.baseProfitFactor || "1.1 default", null],
    ["Main validation samples", settings.mainEvalPosCount || "8 default", null],
    ["Real validation samples", settings.realEvalPosCount || "8 default", null],
    ["Live entries", liveEnabled ? "Enabled" : "Paused", liveEnabled],
  ] as const
  const selectedNav = NAV.find(n => n.id === view)!

  return <div className="terminal-workspace">
    <a className="terminal-skip" href="#terminal-main">Skip to terminal</a>
    <header className="terminal-topbar"><Link className="terminal-brand" href="/"><span>C</span><strong>CTS-C</strong><small>TRADING SYSTEM</small></Link><div className="terminal-topbar-right"><span className="terminal-scope"><CircleDot size={12} /> PAPER / {selectedConnection.name} {selectedConnection.demo?"VST":"MAINNET"}</span><select className="terminal-input" aria-label="Trading connection" value={connectionId} disabled={busy} onChange={e=>setConnectionId(e.target.value as ConnectionId)}>{CONNECTIONS.map(c=><option key={c.id} value={c.id}>{c.name} · {c.demo?"VST demo":"Mainnet"}</option>)}</select><StyleSwitcher /><ThemeSwitcher /><button onClick={() => setView("strategies")} className="terminal-icon-button" aria-label="Strategy settings"><Settings2 size={17} /></button><button className="terminal-button subtle" onClick={() => void logout()}>Sign out</button></div></header>
    <div className="terminal-app-nav"><nav aria-label="Terminal views">{NAV.map(item => <button key={item.id} onClick={() => setView(item.id)} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined}><item.icon size={16} /><span>{item.label}</span></button>)}</nav><button className="terminal-button subtle" onClick={() => void refresh()} aria-label="Refresh terminal"><RefreshCw size={14} /><span>Refresh</span></button></div>
    <main id="terminal-main" className="terminal-main">
      <div className="terminal-hero"><div className="terminal-hero-left"><div className={`terminal-orb ${running ? "running" : ""}`}><Workflow size={28} /></div><div><p className="terminal-kicker">AUTONOMOUS WORKSPACE / {selectedNav.label.toUpperCase()}</p><h1>CTS-C <span>Terminal</span></h1><p className="terminal-hero-state"><i className={running ? "online" : ""} />{snapshot ? snapshot.readiness.engineStatus : "Connecting"}<span>•</span>{snapshot ? `Snapshot ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : "Waiting for engine data"}</p></div></div><div className="terminal-hero-balance"><p className="terminal-kicker">EXCHANGE EQUITY</p><strong>{money(snapshot?.equity)}</strong><small>{snapshot?.equity == null ? "Awaiting verified account snapshot" : "Reported exchange equity"}</small></div></div>
      {error && <div className="terminal-notice error" role="alert"><Radio size={16} /><span>{error}{snapshot && " · Showing last received snapshot"}</span><button onClick={() => void refresh()}>Retry</button></div>}
      {notice && <div className="terminal-notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div>}
      <MarketTape key={connectionId} demo={selectedConnection.demo} />
      {snapshot?.metricScope && <p className="terminal-metric-scope"><span className="terminal-tag">SOURCE</span> {snapshot.metricScope}{snapshot.paperEquity != null && <span> · Paper equity {money(snapshot.paperEquity)}</span>}</p>}
      <div className="terminal-summary"><div><span>Lifetime paper realized P&L</span><strong className={snapshot && snapshot.realizedPnl < 0 ? "terminal-negative" : "terminal-positive"}>{money(snapshot?.realizedPnl)}</strong><small>See ledger source labels</small></div><div><span>Paper open positions</span><strong>{snapshot ? count(snapshot.positionCount ?? open.length) : "—"}</strong><small>{snapshot ? `${(snapshot.positionCount ?? open.length) > open.length ? "Shown: " : ""}${snapshot.paperTotals?.longOpen ?? open.filter(p => p.direction.toLowerCase() === "long").length} long / ${snapshot.paperTotals?.shortOpen ?? open.filter(p => p.direction.toLowerCase() === "short").length} short` : "Awaiting snapshot"}</small></div><div><span>Paper closed win rate</span><strong>{snapshot?.paperTotals?.winRate != null ? `${snapshot.paperTotals.winRate.toFixed(1)}%` : closed.length ? `${(winCount / closed.length * 100).toFixed(1)}%` : "—"}</strong><small>{count(snapshot?.paperTotals?.closed ?? closed.length)} lifetime closes</small></div><div><span>Lifetime paper costs</span><strong>{money(snapshot?.fees)}</strong><small>Modeled fees and slippage</small></div></div>

      {view === "terminal" && <div className="terminal-command-grid"><aside className="terminal-module-rail" aria-label="Processing modules"><div className="terminal-rail-label">PROCESSING MODULES <span>06</span></div>{modules.map(module => <button key={module.title} className={`terminal-module ${module.color}`} onClick={() => setView(module.view)}><div><module.icon size={17} /><strong>{module.title}</strong><ChevronRight size={13} /></div><p>{module.sub}</p><small>{module.metric}</small></button>)}<div className="terminal-operator"><ShieldCheck size={18} /><p>Connection isolation<span>Actions and settings target {selectedConnection.name} {selectedConnection.demo?"demo":"mainnet"}.</span></p></div></aside>
        <div className="terminal-command-content">
          <Panel title="Strategy progression" kicker="PAPER VALIDATION / INDEPENDENT SETS" action={<span className="terminal-tag"><Workflow size={12} /> Base → Live</span>}><div className="terminal-stage-row">{["base", "main", "real", "live"].map((stage, index) => { const data = snapshot?.stages[stage] ?? EMPTY_STAGE; return <div className={`terminal-stage stage-${index}`} key={stage}><div className="terminal-stage-node"><span>{String(index + 1).padStart(2, "0")}</span>{index === 3 ? <Zap size={20} /> : <Layers size={20} />}</div><h3>{stage}</h3><strong>{snapshot ? count(data.sets) : "—"}<small>sets</small></strong><p>{count(data.eligible)} eligible</p><div className="terminal-stage-foot">Validated PF {formatProfitFactor(data.validatedWindow?.profitFactor, data.validatedWindow?.pfState)}<br />Forward PF {formatProfitFactor(data.admittedForward?.profitFactor, data.admittedForward?.pfState)}<br />Lifetime {formatProfitFactor(data.pf, data.pfState)}</div></div> })}</div><p className="terminal-ledger-note">Active set counts exclude retired configurations. Window PF uses current last-N evidence; lifetime PF retains all recorded losses.</p></Panel>
          {snapshot && <ProgressionDetails stages={snapshot.stages} />}{snapshot?.engine?.equityHistory && <PaperEquity history={snapshot.engine.equityHistory} />}<div className="terminal-analysis-grid"><Panel title="Validation rules" kicker="FILTER / CURRENT CONFIGURATION" action={<button className="terminal-link" onClick={() => setView("strategies")}>Configure <ArrowUpRight size={13} /></button>}><div className="terminal-rule-list">{rules.map(([label, value, okay]) => <div key={label}><span className={`terminal-rule-dot ${okay === true ? "pass" : okay === false ? "hold" : ""}`} /> <span>{label}</span><strong>{value}</strong></div>)}</div></Panel><Panel title="Sample readiness" kicker="ANALYST / BASE LAST-N"><div className="terminal-readiness"><SampleGauge value={base.samplesPercent} /><div><strong>{base.enoughSamples == null ? "Not reported" : `${count(base.enoughSamples)} / ${count(base.sets)} sets`}</strong><p>Enough closed samples for independent validation.</p><span className="terminal-tag">PF neutral = 1.0</span></div></div></Panel></div>
          <MarketTerminal key={connectionId} demo={selectedConnection.demo} />
          <div className="terminal-analysis-grid"><Panel title="Qualification funnel" kicker="EVALUATION / CURRENT SNAPSHOT"><div className="terminal-funnel">{["base", "main", "real", "live"].map(stage => { const data = snapshot?.stages[stage] ?? EMPTY_STAGE; const fraction = data.sets ? Math.min(100, data.eligible / data.sets * 100) : 0; return <div key={stage}><div><span>{stage}</span><strong>{data.eligible} / {data.sets}</strong></div><div className="terminal-bar"><span style={{ width: `${fraction}%` }} /></div><small>{data.samplesPercent == null ? "Sample sufficiency not reported" : `${data.samplesPercent.toFixed(1)}% have enough samples`}</small></div> })}</div></Panel><EventLog events={events} /></div>
          <Positions open={open} closed={closed} openTotal={snapshot?.positionCount} compact />
        </div>
      </div>}
      {view === "strategies" && <StrategyLab key={connectionId} connectionName={connectionName} coordinationStats={snapshot?.coordinationStats} symbolFees={snapshot?.engine?.symbolFees} settings={settings} busy={busy} onSave={value => execute("save-settings", value)} />}
      {view === "integrations" && <IntegrationsPanel />}
      {view === "positions" && <div className="terminal-execution-ledger"><ExecutionLedger execution={snapshot?.execution} /><Positions open={open} closed={closed} openTotal={snapshot?.positionCount} /></div>}
      {view === "activity" && <EventLog events={events} full />}
      {view === "connections" && <div className="terminal-connections-grid"><Panel title={`${selectedConnection.name} execution control`} kicker={`BINGX / ${selectedConnection.demo?"VST DEMO":"FUNDED MAINNET"}`}><div className="terminal-connection-controls"><div className="terminal-connection-status"><Plug size={28} /><div><strong>{snapshot?.readiness.status ?? "Reading connection state"}</strong><p>Verify the dedicated {selectedConnection.name} server credentials to start this account’s engine.</p></div></div><div className="flex flex-wrap gap-3"><button className="terminal-button" disabled={busy} onClick={() => action("configure-connection")}><Plug size={15} />Verify {connectionName} environment</button><button className="terminal-button primary" disabled={busy || !ready} onClick={() => action("start-connection")}><Play size={15} />Verify & start {connectionName}{selectedConnection.demo?"":" mainnet"}</button><button className="terminal-button" disabled={busy || !activeConnection} onClick={() => action("pause-connection")}><Pause size={15} />Pause new entries</button></div><p className="terminal-muted text-xs">Pausing entries keeps position monitoring active. Exchange credentials stay on the server.</p><button className="terminal-link" onClick={() => setView("strategies")}>Configure strategy and execution parameters <ArrowUpRight size={14} /></button></div></Panel><Panel title="Connection inventory" kicker="ISOLATED ACCOUNTS"><div className="terminal-connection-list">{(snapshot?.connections ?? []).map(connection => <div key={connection.id}><span className="terminal-connection-icon"><Plug size={19} /></span><div><strong>{connection.name}</strong><p>{connection.exchange} · {connection.id}</p></div><span className="terminal-tag">{connection.demo ? "DEMO" : "MAINNET"}</span><span className={connection.configured ? "terminal-positive" : "terminal-muted"}>{connection.configured ? "Configured" : "Unconfigured"}</span></div>)}</div></Panel></div>}
      <footer className="terminal-footer"><span><CircleDot size={12} /> CTS-C · Persistent engine telemetry</span><span>{snapshot?.metricScope || "Source labels distinguish paper calculations from exchange results."}</span></footer>
    </main>
  </div>
}
