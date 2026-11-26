"use client"
import {BlockPolicyFields} from "../../shared/cts-lastn/fields";
import type {BlockPolicy} from "../../shared/cts-lastn/blocks";
import {PORTED_CATALOG,DEFAULT_TACTIC_SOURCES,DEFAULT_INVERSE_SOURCES} from "@/shared/cts-indications/catalog"
import { RESEARCH_TACTIC_SOURCES, SIGNAL_TIMEFRAMES } from "@/shared/cts-indications/research-sources"
import { EXEC_PROFILES } from "@/core/exec-profile"
import execDcaTrendPreset from "@/research-data/exec-dca-trend-preset.json"
import { PARABOLIC_SAR_VARIANTS, RSI_VARIANTS, RSI_CONTINUATION_SOURCES, SAR_CONTINUATION_SOURCES, THIN_OSCILLATOR_SOURCE_IDS } from "@/shared/cts-indications/oscillator-sources"
import {SIGNALS_CATALOG,DEFAULT_SIGNALS_SOURCES,SIGNAL_SOURCES} from '@/shared/cts-indications/signals-catalog'
import { DEFAULT_LOW_RANGE_SOURCES, LOW_RANGE_CATALOG } from "@/shared/cts-indications/low-range-catalog"
import {VolumeRatioSliders} from "../../shared/cts-volume/sliders.tsx";
import {SYSTEM_VOLUME_DIVISOR} from "../../shared/cts-volume/ratios.ts"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Download, Layers3, RotateCcw, Save, SlidersHorizontal, Upload } from "lucide-react"
import { ReplayStudy } from "./replay-study"
import { CORE_INDICATIONS, CORE_SIGNAL_PERIODS } from "@/core/indications"
import {formatProfitFactor} from './profit-factor'
import { DEFAULT_EXIT_MODES, type ProfitFactorState, type Stage, type Coordination, type ExitMode } from '@/core/types'

import { RANGES, STEPS, RATIOS, BALANCED_STEPS, BALANCED_RATIOS, MODES, INDICATIONS, DEFAULTS, NUMERIC_FIELDS, EXEC_PF_FIELD, AUTO_PF_FIELDS, COST_FIELDS, COORDINATION_FIELDS, EXECUTION_FIELDS, FACTOR_FIELDS, configurationCount, validateConfiguration, hydrate } from "@/core/settings-schema"
import { SELECTABLE_STOP_DISTANCE_PCTS, SELECTABLE_TRAIL_DISTANCE_PCTS } from "@/core/protection-grid"
import { BRANCH_COORDINATIONS, type StageCoordinations } from "@/core/stage-branches"
import { EXEC_EVALUATION_STAGES, EXEC_LONG_COUNTS, EXEC_LAST_COUNTS, EXEC_LONG_MODES, EXEC_OUTCOMES, POSITIVE_EXEC_OUTCOME, LAST_N_STAGES, execPathCount, stageShortCounts, type ExecWindows, type LastNGrid } from "@/core/last-n-grid"

const EXIT_LABELS: Record<ExitMode, string> = {
  fixed: "Fixed TP and SL",
  trailing: "Dynamic trailing",
  "trailing-only": "Dynamic trailing-only",
  "trailing-fixed": "Fixed-distance trailing",
  "trailing-only-fixed": "Fixed-distance trailing-only",
}
const STRATEGY_SOURCES = [...PORTED_CATALOG,...RESEARCH_TACTIC_SOURCES]
const OSCILLATOR_FAMILIES = [["RSI configurations",[...RSI_VARIANTS,...RSI_CONTINUATION_SOURCES]],["Parabolic SAR configurations",[...PARABOLIC_SAR_VARIANTS,...SAR_CONTINUATION_SOURCES]]] as const
const OSCILLATOR_IDS = new Set<string>(OSCILLATOR_FAMILIES.flatMap(([,sources])=>sources.map(source=>source.id)))

function MultiChoice({ title, description, values, selected, onChange, format, optional = false }: {
  title: string; description: string; values: readonly (string | number)[]; selected: (string | number)[];
  onChange: (values: (string | number)[]) => void; format?: (value: string | number) => string; optional?: boolean
}) {
  const toggle = (value: string | number) => {
    if (selected.includes(value)) { if (optional || selected.length > 1) onChange(selected.filter(item => item !== value)) }
    else onChange(values.filter(item => item === value || selected.includes(item)))
  }
  return (
    <fieldset className="space-y-3">
      <legend className="flex w-full flex-wrap items-center justify-between gap-2 text-sm font-semibold">
        <span>{title}</span>
        <button type="button" className="text-xs text-[var(--terminal-blue)] hover:underline disabled:opacity-40" disabled={selected.length === values.length} onClick={() => onChange([...values])}>Select all</button>
      </legend>
      <p className="terminal-muted text-xs leading-relaxed">{description}</p>
      <div className="flex flex-wrap gap-2">
        {values.map(value => {
          const active = selected.includes(value)
          return <button key={value} type="button" aria-pressed={active} onClick={() => toggle(value)} className={`rounded-lg border px-3 py-2 font-mono text-xs transition-colors ${active ? "border-cyan-400/40 bg-cyan-400/10 text-[var(--terminal-blue)]" : "border-[var(--terminal-border)] terminal-muted hover:border-[var(--terminal-accent)]"}`}>
            {active && <Check className="mr-1.5 inline h-3 w-3" />}{format ? format(value) : value}
          </button>
        })}
      </div>
    </fieldset>
  )
}

export interface CoordinationRow {stage:Stage;coordination:Coordination;lanes:number;closed:number;profitFactor:number;pfState:ProfitFactorState;netPnl:number;samplesPercent:number|null;normalPF:number;normalPfState:ProfitFactorState;normalCloses:number;pfRatio:number|null;notionalFactor:number;executed?:{closed:number;profitFactor:number;pfState:ProfitFactorState}}
function CoordinationComparison({rows}:{rows:CoordinationRow[]}){
  const [stage,setStage]=useState<Stage>('base')
  return <section className="terminal-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Coordination versus Normal</h3><select className="terminal-input" aria-label="Coordination comparison stage" value={stage} onChange={e=>setStage(e.target.value as Stage)}>{['base','main','real','exec','live'].map(s=><option key={s} value={s}>{s.toUpperCase()}</option>)}</select></div><p className="terminal-muted my-4 text-xs leading-relaxed">Current configuration cohorts, net of modeled costs. These lanes have independent entries and gates. Ratios compare cohorts; the research report uses matched entries and equal reserved budgets. Live here is paper execution.</p><div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><thead className="terminal-muted"><tr>{['Lane','Closes','PF',...(stage==='exec'?['Executed PF / closes']:[]),'Normal PF / closes','PF ratio','Enough samples','Budget ratio'].map(c=><th key={c} className="px-3 py-3">{c}</th>)}</tr></thead><tbody>{rows.filter(r=>r.stage===stage).map(r=><tr key={r.coordination} className="border-t border-[var(--terminal-border)]"><th className="px-3 py-3 capitalize">{r.coordination}</th><td className="px-3 py-3">{r.closed}</td><td className="px-3 py-3">{formatProfitFactor(r.profitFactor,r.pfState)}</td>{stage==='exec'&&<td className="px-3 py-3">{formatProfitFactor(r.executed?.profitFactor,r.executed?.pfState)} / {r.executed?.closed??0}</td>}<td className="px-3 py-3">{formatProfitFactor(r.normalPF,r.normalPfState)} / {r.normalCloses}</td><td className="px-3 py-3">{r.pfRatio===null?'—':r.pfRatio.toFixed(2)+'×'}</td><td className="px-3 py-3">{r.samplesPercent===null?'—':r.samplesPercent.toFixed(1)+'%'}</td><td className="px-3 py-3">{r.notionalFactor}×</td></tr>)}</tbody></table></div>{!rows.length&&<p className="terminal-muted py-4 text-xs">No coordination evidence has been recorded.</p>}</section>
}

export function StrategyLab({ settings, onSave, busy,connectionName='x02',coordinationStats=[],symbolFees={},feeReadFailures=[],feeCheckedAt=null }: { settings: Record<string, string>; onSave: (settings: Record<string, unknown>) => Promise<void>; busy: boolean;connectionName?:string;coordinationStats?:CoordinationRow[];symbolFees?:Record<string,{makerFeePct:number;takerFeePct:number}>;feeReadFailures?:string[];feeCheckedAt?:number|null }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => hydrate(settings))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceFilter,setSourceFilter]=useState('')
  const [signalsFilter,setSignalsFilter]=useState('')
  const dirtyRef = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)
  const serverFingerprint = JSON.stringify(settings)
  useEffect(() => {
    if (!dirtyRef.current) setDraft(hydrate(JSON.parse(serverFingerprint) as Record<string, string>))
  }, [serverFingerprint])
  const change = (key: string, value: unknown) => {
    dirtyRef.current = true; setDirty(true); setMessage(null); setError(null)
    setDraft(current => ({ ...current, [key]: value }))
  }
  const selected = (key: string) => draft[key] as (string | number)[]
  const coreCount = useMemo(() => configurationCount(draft), [draft])
  const execEnabled = draft.stageGateMode === "exec-branches"
  const execWindows = draft.strategyExecWindows as ExecWindows
  const budget = Number(draft.baseNotional) * Number(draft.volumeFactor) / SYSTEM_VOLUME_DIVISOR
  const updateExecBlock = (stage: keyof ExecWindows, block: "long" | "short" | "last" | "shortOutcomes" | "lastOutcomes", value: (string | number)[]) =>
    change("strategyExecWindows", { ...execWindows, [stage]: { ...execWindows[stage], [block]: value } })
  const sourceChoices=useMemo(()=>{const q=sourceFilter.trim().toLowerCase(),selected=new Set(draft.strategyIndicationSources as string[]);return STRATEGY_SOURCES.filter(s=>selected.has(s.id)||!q||`${s.id} ${s.label}`.toLowerCase().includes(q))},[sourceFilter,draft.strategyIndicationSources])
  const updateSourceFamily = (family: readonly {id:string}[], sources: string[]) => {
    const familyIds = new Set(family.map(source=>source.id))
    change("strategyIndicationSources",[...(draft.strategyIndicationSources as string[]).filter(id=>!familyIds.has(id)),...sources])
    if (sources.length && !selected("strategyIndicationTypes").includes("Tactic")) change("strategyIndicationTypes",[...selected("strategyIndicationTypes"),"Tactic"])
  }
  const reset = () => {
    dirtyRef.current = false; setDirty(false); setDraft(hydrate(settings)); setError(null); setMessage(null)
  }
  const preset = (kind: "micro" | "balanced" | "full") => {
    const name = kind === "micro" ? "Micro + Low-Range" : kind === "balanced" ? "Balanced" : "Full catalog"
    dirtyRef.current = true; setDirty(true); setError(null); setMessage(`${name} preset prepared. Save to apply it to ${connectionName}.`)
    setDraft(current => ({ ...current, strategyEnabledRanges: kind === "micro" ? ["Micro", "Low-Range"] : kind === "balanced" ? RANGES.filter(r=>r!=="Low-Range") : [...RANGES],
      strategyPriceDistancesEnabled: false, strategyLastNGrid: {}, strategyTpSteps: kind === "micro" ? [2, 3, 4, 5] : kind === "balanced" ? [...BALANCED_STEPS] : [...STEPS],
      strategySlRatios: kind === "balanced" ? [...BALANCED_RATIOS] : kind === "micro" ? RATIOS.filter(r=>r<=1.6) : [...RATIOS], strategyExitModes: kind === "full" ? [...MODES] : [...DEFAULT_EXIT_MODES], strategyIndicationTypes: kind==="full"?[...INDICATIONS]:[...CORE_INDICATIONS],
      baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1,
      mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20, ...(kind==="micro"?{autoPfEnabled:true,blockBehavior:"rounds",microTradeStream:true,strategySignalTimeframes:[1/6,1],microTrailRatio:.5}:{} ) }))
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setMessage(null)
    let output: Record<string, unknown>
    try { output = validateConfiguration(draft, { formNumbers: true }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid configuration."); return }
    setSaving(true)
    try { await onSave(output); dirtyRef.current = false; setDirty(false); setMessage(`Strategy configuration saved to ${connectionName}.`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save strategy configuration.") }
    finally { setSaving(false) }
  }
  const exportConfiguration = () => {
    setError(null); setMessage(null)
    try {
      const output = validateConfiguration(draft, { formNumbers: true })
      const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url; anchor.download = `cts-c-strategy-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage("Current strategy draft exported. Only editable configuration values are included.")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export configuration.") }
  }
  const importConfiguration = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setImporting(true); setError(null); setMessage(null)
    try {
      if (file.size > 2_097_152) throw new Error("Configuration file must be 2 MB or smaller.")
      let parsed: unknown
      try { parsed = JSON.parse(await file.text()) }
      catch { throw new Error("Could not read valid JSON from this configuration file.") }
      const imported = validateConfiguration(parsed, { partial: true })
      const next = validateConfiguration({ ...draft, ...imported }, { formNumbers: true })
      dirtyRef.current = true; setDirty(true); setDraft(next)
      setMessage(`Imported ${Object.keys(imported).length} settings into the draft. Review the unsaved configuration, then choose Save configuration to apply it.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import configuration.") }
    finally { input.value = ""; setImporting(false) }
  }
  const numberField = (field: (typeof NUMERIC_FIELDS)[number]) => (
    <label key={field.key} className="space-y-2 text-xs">
      <span className="block terminal-muted">{field.label}</span>
      <input aria-label={field.label} className="terminal-input w-full" type="number" min={field.min} max={field.max} step={field.step} required value={String(draft[field.key] ?? "")} onChange={event => change(field.key, event.target.value)} />
      {settings[field.key] === undefined && <span className="block text-[10px] terminal-muted">Default · {String(DEFAULTS[field.key])}</span>}
    </label>
  )
  const enumField = (key: string, label: string, options: { value: string; label: string }[]) => (
    <label className="space-y-2 text-xs"><span className="block terminal-muted">{label}</span><select aria-label={label} className="terminal-input w-full" value={String(draft[key])} onChange={event => change(key, event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{settings[key] === undefined && <span className="block text-[10px] terminal-muted">Default · {String(DEFAULTS[key])}</span>}</label>
  )
  const windowOptions = [
    { value: "context", label: "Exact symbol and side" },
    { value: "config", label: "Same configuration across symbols and sides" },
    { value: "both", label: "Require both windows" },
  ]
  return (
    <>
    <form onSubmit={save} className="space-y-5">
      <fieldset disabled={busy || saving || importing} className="min-w-0 space-y-5">
      <section className="terminal-panel space-y-3 p-5"><h3 className="text-sm font-semibold">Tactic & Inverse · independent indication sources</h3><p className="terminal-muted text-xs">Tactic includes conventional indicators, RSI momentum, quarter-hour order flow and DCA recovery. Inverse qualifies its own results. Market and pair sources require observed reference symbols.</p>
        <button type="button" className="terminal-button" onClick={()=>{change('strategyIndicationTypes',[...new Set([...(draft.strategyIndicationTypes as string[]),'Tactic','Inverse'])]);change('strategyIndicationSources',[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES])}}>Prepare Tactic + Inverse</button>
        <button type="button" className="terminal-button ml-2" onClick={()=>{change('strategyIndicationTypes',[...new Set([...(draft.strategyIndicationTypes as string[]),'Tactic'])]);change('strategyIndicationSources',[...new Set([...(draft.strategyIndicationSources as string[]),...RESEARCH_TACTIC_SOURCES.filter(source=>!OSCILLATOR_IDS.has(source.id)).map(source=>source.id)])])}}>Add indicator variants</button>
        <label className="block text-xs">Search source configurations<input className="terminal-input mt-2 w-full" value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)} placeholder="Decline, recovery, trend, pair…" /></label>
        <label className="block text-xs">Independent source configurations<select multiple size={7} className="terminal-input mt-2 w-full" aria-label="Tactic and Inverse source configurations" value={draft.strategyIndicationSources as string[]} onChange={e=>change('strategyIndicationSources',Array.from(e.target.selectedOptions,o=>o.value))}>{sourceChoices.map(s=><option key={s.id} value={s.id}>{s.label} · {s.id}</option>)}</select></label>
        <p className="terminal-muted text-xs">{(draft.strategyIndicationSources as string[]).length} selected · {STRATEGY_SOURCES.length} available. Conventional and RSI momentum variants also support 60m. Inverse and quarter-hour sources use 1/5/15m.</p>
        <details className="space-y-3 border-t border-[var(--terminal-border)] pt-4">
          <summary className="cursor-pointer text-sm font-semibold">RSI and Parabolic SAR</summary>
          <p className="terminal-muted text-xs">RSI Reclaim signals on a return through an extreme threshold. RSI Momentum signals on the move into an extreme. Parabolic SAR signals when a direction begins. Continuation sources can signal after a previous position closed while the direction is still confirmed.</p>
          <div className="grid gap-3 sm:grid-cols-2">{OSCILLATOR_FAMILIES.map(([label,sources])=><label key={label} className="text-xs">{label}
            <select multiple size={6} aria-label={label} className="terminal-input mt-2 w-full"
              value={(draft.strategyIndicationSources as string[]).filter(id=>sources.some(source=>source.id===id))}
              onChange={event=>updateSourceFamily(sources,Array.from(event.target.selectedOptions,option=>option.value))}>
              {sources.map(source=><option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
          </label>)}</div>
          <button type="button" className="terminal-button" onClick={()=>{
            dirtyRef.current=true; setDirty(true); setError(null)
            setDraft(current=>({...current,stageGateMode:"exec-branches",strategyIndicationTypes:["Tactic"],strategyIndicationSources:[...THIN_OSCILLATOR_SOURCE_IDS],
              strategyEnabledRanges:["Micro","Low-Range","Minimal"],strategyTpSteps:[3,6,8],strategySignalTimeframes:[1],
              strategyPriceDistancesEnabled:true,strategyStopDistancePcts:[.10,.15],strategyTrailDistancePcts:[.05,.10],
              strategyExitModes:["fixed","trailing-fixed"],microMinSlDistancePct:.10,microMinTrailDistancePct:.05}))
            setMessage("RSI and Parabolic SAR draft prepared. Save it to use it in the replay.")
          }}>Prepare RSI and SAR thin preset</button>
        </details>
      </section>
      <section className="terminal-panel space-y-4 p-5">
        <h3 className="text-sm font-semibold">Low-Range indications</h3>
        <p className="terminal-muted text-xs">Each source, timeframe and protection variant evaluates its own Low-Range Set.</p>
        <button type="button" className="terminal-button" onClick={() => {
          change("strategyIndicationTypes", ["Low-Range"])
          change("strategyEnabledRanges", ["Low-Range"])
          change("strategyTpSteps", [2, 3, 4, 5, 6])
          change("strategySignalTimeframes", [1, 5, 15])
          change("strategyLowRangeSources", [...DEFAULT_LOW_RANGE_SOURCES])
        }}>Prepare Low-Range indications</button>
        <label className="block text-xs">Low-Range source configurations
          <select multiple size={7} className="terminal-input mt-2 w-full" aria-label="Low-Range source configurations" value={draft.strategyLowRangeSources as string[]}
            onChange={event => change("strategyLowRangeSources", [...event.target.selectedOptions].map(option => option.value))}>
            {LOW_RANGE_CATALOG.map(source => <option value={source.id} key={source.id}>{source.label}</option>)}
          </select>
        </label>
      </section>
      <section className="terminal-panel space-y-4 p-5" aria-label="Relational volume"><h3 className="text-sm font-semibold">Relational volume · Indications</h3><VolumeRatioSliders overall value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{indicationTypes:INDICATIONS,indications:[...(draft.strategyIndicationSources as string[]), ...(draft.strategyLowRangeSources as string[])]}}/></section>
      <section className="terminal-panel space-y-4 p-5"><h3 className="text-sm font-semibold">Relational volume · Strategies & Ranges</h3><VolumeRatioSliders value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{strategies:['normal','axis','block','dca','relate'],ranges:RANGES}}/></section>
      {Object.keys(symbolFees).length>0&&<section className="terminal-panel space-y-4 p-5"><h3 className="text-sm font-semibold">Relational volume · Symbols</h3><VolumeRatioSliders value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{symbols:Object.keys(symbolFees)}}/></section>}
      <section className="terminal-panel space-y-4 p-5" aria-label="Signals settings">
        <h3 className="text-sm font-semibold">Signals · sources &amp; independent voting bands</h3>
        <p className="terminal-muted text-xs">{SIGNAL_SOURCES.length} computed source families, short/medium variants and independent category coordinators. Each source votes once; conflicting variants abstain. These use observed exchange candles, not third-party trade recommendations.</p>
        <button type="button" className="terminal-button" onClick={()=>{dirtyRef.current=true;setDirty(true);setDraft(current=>({...current,strategyIndicationTypes:['Signals'],strategySignalsSources:[...DEFAULT_SIGNALS_SOURCES],strategyEnabledRanges:['Micro','Low-Range','Minimal','Short'],strategyTpSteps:[2,3,5,8,12],strategySlRatios:[.6,1],strategyExitModes:[...DEFAULT_EXIT_MODES],strategySignalTimeframes:[1],signalsMaxWindowDrawdownPct:3}));setMessage('Signals draft prepared. Save to apply it. Research results do not guarantee profitable execution.')}}>Prepare Signals preset</button>
        <label className="block text-xs">Filter Signals sources<input className="terminal-input mt-2 w-full" aria-label="Filter Signals sources" value={signalsFilter} onChange={e=>setSignalsFilter(e.target.value)} placeholder="Trend, breakout, volume, research, minimum 3..."/></label>
        <label className="block text-xs">Signals source configurations<select multiple size={8} className="terminal-input mt-2 w-full" aria-label="Signals source configurations" value={draft.strategySignalsSources as string[]} onChange={e=>change('strategySignalsSources',Array.from(e.target.selectedOptions,o=>o.value))}>{SIGNALS_CATALOG.filter(s=>(draft.strategySignalsSources as string[]).includes(s.id)||`${s.category} ${s.label}`.toLowerCase().includes(signalsFilter.toLowerCase())).map(s=><option key={s.id} value={s.id}>{s.category} · {s.label}</option>)}</select></label>
        <p className="terminal-muted text-xs">{(draft.strategySignalsSources as string[]).length} selected / {SIGNALS_CATALOG.length} available. Gate return-drawdown limit below uses cumulative net-return percentage points in each own Last-N window. It is a qualification filter, not a future account-drawdown guarantee.</p>
        <VolumeRatioSliders value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{indications:draft.strategySignalsSources as string[]}}/>
      </section>
      <section className="terminal-panel space-y-4 p-5" aria-label="Strategy processing">
        <h3 className="text-sm font-semibold">Strategy processing · Normal & Trailing</h3>
        <p className="terminal-muted text-xs">Normal off keeps calculation and Axis/Block/DCA progression, including their fixed exits. Plain Normal and plain Trailing lanes cannot enter Live. Trailing off excludes every new trailing configuration. Both the overall and range switch must be on.</p>
        <div className="flex flex-wrap gap-5">{([['strategyNormalEnabled','Normal · overall'],['strategyTrailingEnabled','Trailing · overall']] as const).map(([key,label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft[key] !== false} onChange={e=>change(key,e.target.checked)} />{label}</label>)}</div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Coordination / Range</th><th>Normal</th><th>Trailing</th></tr></thead><tbody>{RANGES.map(range => <tr key={range}><th className="py-2 font-normal">{range}</th>{(['normal','trailing'] as const).map(key => {
          const byRange = (draft.strategyProcessingByRange ?? {}) as Record<string, {normal?:boolean;trailing?:boolean}>
          return <td key={key}><input type="checkbox" aria-label={`${range} ${key} processing`} checked={byRange[range]?.[key] !== false} onChange={e=>change('strategyProcessingByRange',{...byRange,[range]:{...byRange[range],[key]:e.target.checked}})} /></td>
        })}</tr>)}</tbody></table></div>
      </section>
      <div className="terminal-panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div><p className="terminal-muted text-[10px] uppercase tracking-[.2em]">{connectionName.toUpperCase()} / Configuration studio</p><h2 className="mt-1 text-xl font-semibold">Independent strategy combinations</h2><p className="terminal-muted mt-2 max-w-2xl text-xs leading-relaxed">Ranges, distances, exit modes, and indications generate separate core configurations. Axis, Block, and DCA coordinate their progression.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="terminal-button" disabled={busy || saving} onClick={()=>{
            dirtyRef.current=true; setDirty(true); setError(null)
            setDraft(current=>({...current,...structuredClone(execDcaTrendPreset)}))
            setMessage("Trend + DCA replay draft prepared with 10 days of warm-up. Review the settings before saving.")
          }}>Prepare Trend + DCA replay preset</button>
          <button type="button" onClick={() => preset("balanced")} className="terminal-button" disabled={busy || saving}>Balanced · 252</button>
          <button type="button" onClick={() => preset("micro")} className="terminal-button" disabled={busy || saving}><Layers3 className="mr-2 inline h-4 w-4" />Micro + Low-Range</button>
          <button type="button" onClick={() => preset("full")} className="terminal-button" disabled={busy || saving}>Full catalog</button>
          <button type="button" onClick={exportConfiguration} className="terminal-button"><Download className="h-4 w-4" />Export JSON</button>
          <button type="button" onClick={() => importInput.current?.click()} className="terminal-button"><Upload className="h-4 w-4" />{importing ? "Importing…" : "Import JSON"}</button>
          <input ref={importInput} type="file" accept="application/json,.json" onChange={importConfiguration} className="hidden" aria-label="Import strategy configuration JSON" />
          <button type="button" onClick={reset} className="terminal-button" disabled={!dirty || busy || saving} aria-label="Discard unsaved strategy changes"><RotateCcw className="h-4 w-4" /></button>
          <button type="submit" className="terminal-button border-cyan-400/40 bg-cyan-400/10 text-[var(--terminal-blue)]" disabled={busy || saving}><Save className="mr-2 inline h-4 w-4" />{saving ? "Saving…" : "Save configuration"}</button>
        </div>
      </div>
      {(message || error) && <p role={error ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${error ? "border-rose-500/30 bg-rose-500/10 text-[var(--terminal-red)]" : "border-cyan-400/30 bg-cyan-400/10 text-[var(--terminal-blue)]"}`}>{error || message}</p>}
      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <section className="terminal-panel space-y-7 p-5">
            <MultiChoice title="Strategy ranges" description="Micro 2–5 · Low-Range 2–8 · Minimal 6–8 · Short 9–12 · Normal 13–18 · Long 19–24 · Wide 25–30 TP steps." values={RANGES} selected={selected("strategyEnabledRanges")} onChange={value => change("strategyEnabledRanges", value)} />
            <MultiChoice title="Take-profit steps" description="TP distance = estimated round-trip position cost × selected step. Only steps within enabled ranges produce configurations." values={STEPS} selected={selected("strategyTpSteps")} onChange={value => change("strategyTpSteps", value)} />
            <label className="flex items-center gap-3 text-xs"><input type="checkbox" checked={draft.strategyPriceDistancesEnabled === true} onChange={event => change("strategyPriceDistancesEnabled", event.target.checked)} />Use price percentages for stop-loss and trailing</label>
            {draft.strategyPriceDistancesEnabled === true ? <>
              <MultiChoice title="Stop-loss price distance" description="Each selected distance creates its own Set. Micro and Low-Range enforce their configured minimum distance." values={SELECTABLE_STOP_DISTANCE_PCTS} selected={selected("strategyStopDistancePcts")} onChange={value => change("strategyStopDistancePcts", value)} format={value => Number(value).toFixed(2) + "%"} />
              <MultiChoice title="Trailing price gap" description="Each selected gap has independent dynamic and fixed-distance Sets when those exit modes are enabled." values={SELECTABLE_TRAIL_DISTANCE_PCTS} selected={selected("strategyTrailDistancePcts")} onChange={value => change("strategyTrailDistancePcts", value)} format={value => Number(value).toFixed(2) + "%"} />
            </> : <MultiChoice title="Stop-loss / take-profit ratio" description="Each ratio creates an independent configuration. SL distance = TP distance × ratio. Micro and Low-Range use 0.2–1.6 in 0.1 steps." values={RATIOS} selected={selected("strategySlRatios")} onChange={value => change("strategySlRatios", value)} format={value => Number(value).toFixed(1) + "×"} />}
            <MultiChoice title="Exit modes" description="Fixed-distance trailing keeps the original entry-price offset. Dynamic trailing recalculates the gap from each new peak." values={MODES} selected={selected("strategyExitModes")} onChange={value => change("strategyExitModes", value)} format={mode => EXIT_LABELS[mode as ExitMode]} />
            <MultiChoice title="Indications" description="Each selected indication evaluates its own configuration history." values={INDICATIONS} selected={selected("strategyIndicationTypes")} onChange={value => change("strategyIndicationTypes", value)} format={value => String(value).replaceAll("_", " ")} />
            <MultiChoice title="Trend & Break lookbacks" description="Each lookback has an independent Set." values={[10,14,20,40,60]} selected={selected('strategySignalPeriods')} onChange={value=>change('strategySignalPeriods',value)} />
            <MultiChoice title="Common indicator lookbacks" description="Separate settings for MA, RSI, MACD and Bollinger families. Original uses 14 for RSI Band and 20 for the others." values={CORE_SIGNAL_PERIODS} selected={selected('strategyCoreSignalPeriods')} onChange={value=>change('strategyCoreSignalPeriods',value)} format={value=>value===0?'Original':String(value)} />
            <MultiChoice title="Signal timeframes" description="10s lanes use recorded WebSocket trades. Longer frames use completed native minutes. Exits also process observed trades." values={SIGNAL_TIMEFRAMES} selected={selected('strategySignalTimeframes')} onChange={value=>change('strategySignalTimeframes',value)} format={value=>Number(value)<1?'10s':value+'m'} />
          </section>
          <section className="terminal-panel p-5">
            <div className="mb-5 flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-[var(--terminal-accent)]" /><h3 className="text-sm font-semibold">Stage gates & completed evidence</h3></div>
            <p className="terminal-muted mb-5 text-xs">PF 1.0 is neutral. Each stage uses its own most recent completed samples. Exec accepts a fresh entry after its own blocks qualify. Live mirrors that entry using the same allocation and exit policy.</p>
            <div className="mb-5">{enumField("stageGateMode", "Stage progression", [{ value: "exec-branches", label: "Exec with independent Last N blocks" }, { value: "parent-branches", label: "Parent branches through Real" }, { value: "processed-sets", label: "Independent processed sets" }, { value: "continuous-ancestors", label: "Recheck all ancestor windows" }])}</div>
            {!execEnabled&&<><div className="mb-3 grid gap-5 sm:grid-cols-2">
              {enumField("stageWindowScope", "Stage evidence scope", windowOptions)}
              {enumField("microStageWindowScope", "Micro and Low-Range evidence scope", [{ value: "inherit", label: "Use stage evidence scope" }, ...windowOptions])}
            </div>
            <p className="terminal-muted mb-5 text-xs">Pooled windows use completed samples from the same configuration, strategy coordination and stage. Exchange entries still require the exact symbol and side to pass.</p>
            <div className="mb-5">{enumField("liveEntryMode", "Live entries", [{ value: "independent", label: "Independent signal entries · legacy baseline" }, { value: "real-mirror", label: "Mirror fresh qualified Real entries" }])}</div>
            <p className="terminal-muted mb-5 text-xs">Real remains the final current PF gate. Mirroring links each new Live position to its fresh Real entry and uses Real evidence for Axis, without another Live evidence gate. Independent processed sets always mirror Real. These progression modes use Real as their final gate.</p></>}
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{(execEnabled ? [...NUMERIC_FIELDS.slice(0,3),EXEC_PF_FIELD] : NUMERIC_FIELDS).map(numberField)}</div>
            {!execEnabled&&(["base","main","real"] as const).map(stage=><BlockPolicyFields key={stage} label={stage+" Last-N blocks"} value={(draft.stageBlocks as Partial<Record<string,BlockPolicy>>|undefined)?.[stage]} onChange={policy=>{const next={...(draft.stageBlocks as Partial<Record<string,BlockPolicy>>??{})};if(policy)next[stage]=policy;else delete next[stage];change("stageBlocks",next)}}/>)}
            <details className="mt-5 space-y-4">
              <summary className="cursor-pointer text-sm font-semibold">Independent Last-N Sets</summary>
              <p className="terminal-muted text-xs">{execEnabled ? "Every combination gets its own Set under each qualifying parent. Long uses the oldest block, Short follows it, and Last uses the newest completed positions." : "Each combination of selected stage sizes runs in its own Set. An empty stage selection uses that stage’s existing window policy."}</p>
              {(execEnabled || draft.stageGateMode === "parent-branches") && (execEnabled ? (["main","real","exec"] as const) : (["main","real"] as const)).map(stage => {
                const map = (draft.strategyStageCoordinations ?? {}) as StageCoordinations
                return <MultiChoice key={stage} title={stage[0].toUpperCase()+stage.slice(1)+" child coordinations"}
                  description={execEnabled?"Each eligible parent creates the selected enabled coordinations. An empty selection runs all enabled coordinations.":"Each eligible parent creates the selected enabled coordinations. An empty selection inherits its coordination."}
                  values={[...BRANCH_COORDINATIONS]} selected={[...(map[stage] ?? [])]} optional
                  onChange={value => change("strategyStageCoordinations", { ...map, [stage]: value })} />
              })}
              {execEnabled ? EXEC_EVALUATION_STAGES.map(stage => {
                const label = stage[0].toUpperCase()+stage.slice(1)
                const windows = execWindows[stage]
                return <section key={stage} className="grid gap-4 border-t border-[var(--terminal-border)] pt-4 sm:grid-cols-2">
                  <h4 className="text-sm font-semibold sm:col-span-2">{label}</h4>
                  <MultiChoice title={label+" Long"} description={stage==="base"?"Completed positions in the oldest block.":"Inherit the originating Base Set’s Long count or omit the block."} values={stage==="base"?[...EXEC_LONG_COUNTS]:[...EXEC_LONG_MODES]} selected={[...windows.long]} onChange={value=>updateExecBlock(stage,"long",value)} format={value=>value==="none"?"No Long":value==="inherit"?"Base Long":String(value)}/>
                  <MultiChoice title={label+" Short"} description="Completed positions immediately before Last." values={[...stageShortCounts(stage)]} selected={[...windows.short]} onChange={value=>updateExecBlock(stage,"short",value)}/>
                  <MultiChoice title={label+" Last"} description="Most recent completed positions." values={[...EXEC_LAST_COUNTS]} selected={[...windows.last]} onChange={value=>updateExecBlock(stage,"last",value)}/>
                  <MultiChoice title={label+" Short outcomes"} description="Each selected size has an independent positive or negative path. The full window must still pass PF." values={EXEC_OUTCOMES} selected={[...(windows.shortOutcomes??POSITIVE_EXEC_OUTCOME)]} onChange={value=>updateExecBlock(stage,"shortOutcomes",value)}/>
                  <MultiChoice title={label+" Last outcomes"} description="Each outcome is an independent Set. A negative Last must sit inside a profitable full window." values={EXEC_OUTCOMES} selected={[...(windows.lastOutcomes??POSITIVE_EXEC_OUTCOME)]} onChange={value=>updateExecBlock(stage,"lastOutcomes",value)}/>
                </section>
              }) : LAST_N_STAGES.map(stage => {
                const grid = (draft.strategyLastNGrid ?? {}) as LastNGrid
                const sizes = [...(grid[stage] ?? [])]
                const options = [...new Set([1, 3, 5, 8, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150, 250, ...sizes])].sort((a, b) => a - b)
                return <MultiChoice key={stage} title={`${stage[0].toUpperCase() + stage.slice(1)} Set window sizes`} description="Number of completed returns per window." values={options} selected={sizes} optional onChange={value => change("strategyLastNGrid", { ...grid, [stage]: value })} />
              })}
            </details>

            {execEnabled&&<div className="mt-5 space-y-2">
              {EXEC_PROFILES.map(profile=><div key={profile.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <label className="flex items-center gap-3 text-xs"><input type="checkbox" checked={draft[profile.setting]===true} onChange={e=>change(profile.setting,e.target.checked)}/>{profile.label} execution profile</label>
                <small className="terminal-muted text-[11px]">Base Long {profile.windows.base.long.join(" / ")} · {profile.windows.base.shortOutcomes?.includes("negative") ? "Signed Short and Last" : "Signed Last"}</small>
              </div>)}
              <p className="terminal-muted text-xs">Enabled profiles add independent 1m configurations with their own Auto PF and Exec Short 4, 8 and 12. The DCA coordination switch applies to all profiles.</p>
            </div>}
            <label className="mt-5 flex items-center gap-3 text-xs"><input type="checkbox" checked={draft.autoPfEnabled===true} onChange={e=>change('autoPfEnabled',e.target.checked)}/>Auto PF</label>
            {draft.autoPfEnabled === true && <div className="mt-3 space-y-3">
              {enumField("autoPfMode", "Auto PF method", [{value:"set-history",label:"Independent Set history"},{value:"tp-distance",label:"Legacy TP distance"}])}
              <p className="terminal-muted text-xs">{draft.autoPfMode === "tp-distance"
                ? "The TP-based floor depends on the configuration's target distance and slope."
                : "Each Set uses its older completed returns to raise the PF requirement when its history is weak. The fallback applies while history is sparse. Every Last-N block still needs its full sample count."}</p>
              <div className="grid gap-5 sm:grid-cols-2">{AUTO_PF_FIELDS.filter(field => field.key === "autoPfMax" || field.key === "autoPfStrength" || (field.key === "autoPfRatio") === (draft.autoPfMode === "tp-distance")).map(numberField)}</div>
            </div>}
            <label className="mt-5 flex items-center gap-3 text-xs"><input type="checkbox" checked={draft.microTradeStream===true} onChange={e=>change('microTradeStream',e.target.checked)}/>Record trades and 10-second history</label>
          </section>
        </div>
        <div className="space-y-5">
          <section className="terminal-panel p-5">
            <p className="terminal-muted text-[10px] uppercase tracking-[.18em]">Configuration preview</p><p className="mt-3 font-mono text-4xl font-semibold text-[var(--terminal-blue)]">{coreCount.toLocaleString()}</p><p className="terminal-muted mt-2 text-xs">Core configurations per symbol, before direction and coordination lanes.</p>{execEnabled&&<p className="terminal-muted mt-2 text-xs">Up to {execPathCount(execWindows).toLocaleString()} Exec paths per geometry and coordination path. Descendants start as their parents qualify.</p>}
            <div className="mt-5 space-y-2 border-t border-[var(--terminal-border)] pt-4 text-xs"><p>{(draft.strategyEnabledRanges as string[]).join(" / ")}</p><p className="terminal-muted">{draft.strategyPriceDistancesEnabled === true ? `${selected("strategyStopDistancePcts").length} stop distances · ${selected("strategyTrailDistancePcts").length} trailing gaps` : `${selected("strategySlRatios").length} stop ratios`} · {selected("strategyExitModes").length} exits · {selected("strategyIndicationTypes").length} indications</p><p className={dirty ? "text-[var(--terminal-amber)]" : "terminal-muted"}>{dirty ? "Unsaved configuration" : "Saved values or labeled defaults"}</p></div>
          </section>
          <section className="terminal-panel space-y-5 p-5">
            <div><h3 className="text-sm font-semibold">Coordination lanes</h3><p className="terminal-muted mt-1 text-xs">Enable each additional evaluator independently.</p></div>
            {[
              ["axisPrevEnabled", "Axis", "History and outcome coordination"],
              ["variantBlockEnabled", "Block", "Block-based volume coordination"],
              ["variantDcaEnabled", "DCA", "Independent accumulation variant"],
              ["relateEnabled", "Relate", "Separate post-Base sizing after settled losses"],
            ].map(([key, label, description]) => <label key={key} className="flex cursor-pointer items-center justify-between gap-4 border-b border-[var(--terminal-border)] pb-3 last:border-0 last:pb-0"><span><span className="block text-xs font-medium">{label}</span><span className="terminal-muted mt-1 block text-[11px]">{description}{settings[key] === undefined ? " · default" : ""}</span></span><input type="checkbox" aria-label={label} className="h-4 w-4 accent-cyan-400" checked={draft[key] === true} onChange={event => change(key, event.target.checked)} /></label>)}
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">Axis windows</h4><p className="terminal-muted text-xs leading-relaxed">Previous samples must meet the stage PF gate. The separate recent window must match the selected outcome. Both windows use the same configuration and direction of the selected Normal reference. Axis still needs its own completed evidence at every stage.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("axis")).map(numberField)}</div>{enumField("axisReferenceStage","Normal reference stage",[{value:'same-stage',label:'Matching stage'},{value:'base',label:'Continuous Base history'}])}{enumField("axisOutcome", "Recent net outcome", [{ value: "any", label: "Any outcome" }, { value: "positive", label: "Positive net result" }, { value: "negative", label: "Negative net result" }])}</div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5">
              <h4 className="text-xs font-semibold">Block allocation</h4>
              <p className="terminal-muted text-xs leading-relaxed">Rounds evaluate completed positions independently per lane. Losing rounds can raise the budget by the configured ratio, up to the step and multiplier caps. Net recovery resets the budget and pauses the configured number of rounds. Pyramid mode adds on favorable moves.</p>
              <div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("block") && !field.key.startsWith("blockAuto")).map(numberField)}</div>
              {enumField("blockBehavior", "Block calculation", [{ value: "rounds", label: "Completed position rounds" }, { value: "pyramid", label: "Favorable-move additions" }])}
              {draft.blockBehavior === "pyramid" && enumField("blockMode", "Pyramid allocation mode", [{ value: "shared", label: "Shared budget" }, { value: "additive", label: "Additive exposure" }])}
              <label className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium">Evaluate each Block increase automatically</span>
                <input type="checkbox" className="h-4 w-4 accent-cyan-400" checked={draft.blockAutoEnabled === true} onChange={event => change("blockAutoEnabled", event.target.checked)} />
              </label>
              {draft.blockAutoEnabled === true && <>
                <p className="terminal-muted text-xs leading-relaxed">Each increase needs its own recent net returns for this config, symbol, direction and stage. Pyramid mode scores observed add triggers at the parent’s exit. Rounds score each budget level on the positions that reached it, including positions held at base size.</p>
                <div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("blockAuto")).map(numberField)}</div>
              </>}
            </div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5">
              <h4 className="text-xs font-semibold">DCA allocation</h4>
              <p className="terminal-muted text-xs leading-relaxed">Adds after the configured adverse move. Each addition uses the base sizing budget × multiplier, up to the selected count.</p>
              <div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("dca") && !field.key.startsWith("dcaAuto")).map(numberField)}</div>
              <label className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium">Evaluate each DCA add step automatically</span>
                <input type="checkbox" className="h-4 w-4 accent-cyan-400" checked={draft.dcaAutoEnabled === true} onChange={event => change("dcaAutoEnabled", event.target.checked)} />
              </label>
              {draft.dcaAutoEnabled === true && <>
                <p className="terminal-muted text-xs leading-relaxed">Each step needs its own recent net returns for this config, stage and direction. The engine observes trigger prices while a step is held and scores them at the parent’s modeled exit. A held step prevents deeper adds in that position.</p>
                <div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("dcaAuto")).map(numberField)}</div>
              </>}
            </div>
          </section>
          {draft.relateEnabled === true && <section className="terminal-panel space-y-4 p-5">
            <h3 className="text-sm font-semibold">Relate allocation</h3>
            <p className="terminal-muted text-xs">A settled loss advances the Set’s recovery step. A win or flat close resets it. A step reaches execution after its own earlier and later trials both clear the PF and drawdown limits. Skipped positions continue in simulation.</p>
            <label className="grid gap-2 text-xs">Relation scope
              <select className="terminal-input" value={String(draft.relateScope ?? "set")} onChange={event => change("relateScope", event.target.value)}>
                <option value="set">Exact Set</option><option value="overall">Overall · all relations</option>
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("relate") &&
              (!field.key.startsWith("relateFactor_") || field.key === "relateFactor_config" || draft.relateScope === "overall")).map(numberField)}</div>
          </section>}
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Market universe & position sizing</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Scan up to this many available contracts. The model divides the configured volume factor by five before applying coordination adjustments. Exchange minimums and quantity precision still apply.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{EXECUTION_FIELDS.map(numberField)}</div><p className="terminal-muted mt-5 border-t border-[var(--terminal-border)] pt-4 text-xs">Initial sizing budget: <span className="font-mono text-[var(--terminal-fg)]">{Number.isFinite(budget) ? budget.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"} USDT</span></p></section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Fee & slippage estimate</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Default taker 0.05% per side gives 0.10% round-trip fees; 10% fee-relative slippage gives 0.11% total modeled cost. The account’s exchange commission pair applies to the selected perpetual symbols. A failed refresh retains the last verified pair. Fee fields below apply when no verified pair is available. Slippage applies to the fee sum. Open positions retain their entry cost model.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{COST_FIELDS.map(numberField)}</div><details className="mt-5 text-xs"><summary className="cursor-pointer">Exchange fee coverage · {Object.keys(symbolFees).length} symbols</summary><p className="terminal-muted my-3">{!feeCheckedAt?"No startup commission check has been recorded.":feeReadFailures.length?`${feeReadFailures.length} symbol reads failed at the latest refresh. Cached pairs are labeled below; symbols without a known pair use configured fallbacks.`:"Latest startup commission reads completed without errors."}</p><div className="mt-3 max-h-60 overflow-auto"><table className="w-full text-left"><thead><tr><th>Symbol</th><th>Maker %</th><th>Taker %</th><th>Source</th></tr></thead><tbody>{Object.entries(symbolFees).map(([symbol,fee])=><tr key={symbol}><th className="py-1 font-normal">{symbol}</th><td>{fee.makerFeePct}</td><td>{fee.takerFeePct}</td><td>{feeReadFailures.includes(symbol)?"Last verified":feeCheckedAt?"Latest refresh":"Recorded"}</td></tr>)}</tbody></table></div></details></section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Ratios & distance factors</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Lane budget = base notional × (volume factor ÷ 5) × lane ratio. TP = cost × step × TP factor. SL = TP × selected SL ratio × SL factor; trail = SL × trail ratio. Existing positions retain their captured settings. The order cap rejects exchange-rounded entries and adds above its value.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{FACTOR_FIELDS.map(numberField)}</div></section>
        </div>
      </div>
      </fieldset>
    </form>
    <CoordinationComparison rows={coordinationStats}/>
    <ReplayStudy key={connectionName} connectionId={connectionName==='x01'?'bingx-x01':'bingx-x02'} />
    </>
  )
}
