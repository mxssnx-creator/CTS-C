"use client"
import {PORTED_CATALOG,DEFAULT_TACTIC_SOURCES,DEFAULT_INVERSE_SOURCES} from "@/shared/cts-indications/catalog"
import {VolumeRatioSliders} from "../../shared/cts-volume/sliders.tsx";

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Download, Layers3, RotateCcw, Save, SlidersHorizontal, Upload } from "lucide-react"
import { ReplayStudy } from "./replay-study"
import { CORE_INDICATIONS } from "@/core/indications"
import {formatProfitFactor} from './profit-factor'
import type {ProfitFactorState,Stage,Coordination} from '@/core/types'

import { RANGES, STEPS, RATIOS, BALANCED_STEPS, BALANCED_RATIOS, MODES, INDICATIONS, DEFAULTS, NUMERIC_FIELDS, AUTO_PF_FIELDS, COST_FIELDS, COORDINATION_FIELDS, EXECUTION_FIELDS, FACTOR_FIELDS, configurationCount, validateConfiguration, hydrate } from "@/core/settings-schema"

function MultiChoice({ title, description, values, selected, onChange, format }: {
  title: string; description: string; values: (string | number)[]; selected: (string | number)[];
  onChange: (values: (string | number)[]) => void; format?: (value: string | number) => string
}) {
  const toggle = (value: string | number) => {
    if (selected.includes(value)) { if (selected.length > 1) onChange(selected.filter(item => item !== value)) }
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

export interface CoordinationRow {stage:Stage;coordination:Coordination;lanes:number;closed:number;profitFactor:number;pfState:ProfitFactorState;netPnl:number;samplesPercent:number|null;normalPF:number;normalPfState:ProfitFactorState;normalCloses:number;pfRatio:number|null;notionalFactor:number}
function CoordinationComparison({rows}:{rows:CoordinationRow[]}){
  const [stage,setStage]=useState<Stage>('base')
  return <section className="terminal-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Coordination versus Normal</h3><select className="terminal-input" aria-label="Coordination comparison stage" value={stage} onChange={e=>setStage(e.target.value as Stage)}>{['base','main','real','live'].map(s=><option key={s} value={s}>{s.toUpperCase()}</option>)}</select></div><p className="terminal-muted my-4 text-xs leading-relaxed">Current configuration cohorts, net of modeled costs. These lanes have independent entries and gates. Ratios compare cohorts; the research report uses matched entries and equal reserved budgets. Live here is paper execution.</p><div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><thead className="terminal-muted"><tr>{['Lane','Closes','PF','Normal PF / closes','PF ratio','Enough samples','Budget ratio'].map(c=><th key={c} className="px-3 py-3">{c}</th>)}</tr></thead><tbody>{rows.filter(r=>r.stage===stage).map(r=><tr key={r.coordination} className="border-t border-[var(--terminal-border)]"><th className="px-3 py-3 capitalize">{r.coordination}</th><td className="px-3 py-3">{r.closed}</td><td className="px-3 py-3">{formatProfitFactor(r.profitFactor,r.pfState)}</td><td className="px-3 py-3">{formatProfitFactor(r.normalPF,r.normalPfState)} / {r.normalCloses}</td><td className="px-3 py-3">{r.pfRatio===null?'—':r.pfRatio.toFixed(2)+'×'}</td><td className="px-3 py-3">{r.samplesPercent===null?'—':r.samplesPercent.toFixed(1)+'%'}</td><td className="px-3 py-3">{r.notionalFactor}×</td></tr>)}</tbody></table></div>{!rows.length&&<p className="terminal-muted py-4 text-xs">No coordination evidence has been recorded.</p>}</section>
}

export function StrategyLab({ settings, onSave, busy,connectionName='x02',coordinationStats=[],symbolFees={},feeReadFailures=[],feeCheckedAt=null }: { settings: Record<string, string>; onSave: (settings: Record<string, unknown>) => Promise<void>; busy: boolean;connectionName?:string;coordinationStats?:CoordinationRow[];symbolFees?:Record<string,{makerFeePct:number;takerFeePct:number}>;feeReadFailures?:string[];feeCheckedAt?:number|null }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => hydrate(settings))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  const reset = () => {
    dirtyRef.current = false; setDirty(false); setDraft(hydrate(settings)); setError(null); setMessage(null)
  }
  const preset = (kind: "micro" | "balanced" | "full") => {
    const name = kind === "micro" ? "Micro + Low-Range" : kind === "balanced" ? "Balanced" : "Full catalog"
    dirtyRef.current = true; setDirty(true); setError(null); setMessage(`${name} preset prepared. Save to apply it to ${connectionName}.`)
    setDraft(current => ({ ...current, strategyEnabledRanges: kind === "micro" ? ["Micro", "Low-Range"] : kind === "balanced" ? RANGES.filter(r=>r!=="Low-Range") : [...RANGES],
      strategyTpSteps: kind === "micro" ? [2, 3, 4, 5] : kind === "balanced" ? [...BALANCED_STEPS] : [...STEPS],
      strategySlRatios: kind === "balanced" ? [...BALANCED_RATIOS] : kind === "micro" ? RATIOS.filter(r=>r<=1.6) : [...RATIOS], strategyExitModes: [...MODES], strategyIndicationTypes: kind==="full"?[...INDICATIONS]:[...CORE_INDICATIONS],
      baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1,
      mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20, ...(kind==="micro"?{stageGateMode:"processed-sets",autoPfEnabled:true,blockBehavior:"rounds",microTradeStream:true,strategySignalTimeframes:[1/6,1],microTrailRatio:.5}:{} ) }))
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
      if (file.size > 131_072) throw new Error("Configuration file must be 128 KB or smaller.")
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
      <input className="terminal-input w-full" type="number" min={field.min} max={field.max} step={field.step} required value={String(draft[field.key] ?? "")} onChange={event => change(field.key, event.target.value)} />
      {settings[field.key] === undefined && <span className="block text-[10px] terminal-muted">Default · {String(DEFAULTS[field.key])}</span>}
    </label>
  )
  const enumField = (key: string, label: string, options: { value: string; label: string }[]) => (
    <label className="space-y-2 text-xs"><span className="block terminal-muted">{label}</span><select className="terminal-input w-full" value={String(draft[key])} onChange={event => change(key, event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{settings[key] === undefined && <span className="block text-[10px] terminal-muted">Default · {String(DEFAULTS[key])}</span>}</label>
  )
  return (
    <>
    <form onSubmit={save} className="space-y-5">
      <fieldset disabled={busy || saving || importing} className="min-w-0 space-y-5">
      <section className="terminal-panel space-y-3 p-5"><h3 className="text-sm font-semibold">Tactic & Inverse · independent indication sources</h3><p className="terminal-muted text-xs">Tactic adds DCA-style adverse-distance and recovery configurations. Inverse uses CTS-A-O calculations before entry and qualifies its own results. Select Tactic / Inverse below to process these sources. Market / pair sources require a matching reference universe; absent references cannot qualify.</p>
        <button type="button" className="terminal-button" onClick={()=>{change('strategyIndicationTypes',[...new Set([...(draft.strategyIndicationTypes as string[]),'Tactic','Inverse'])]);change('strategyIndicationSources',[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES])}}>Prepare Tactic + Inverse</button>
        <label className="block text-xs">Independent source configurations<select multiple size={7} className="terminal-input mt-2 w-full" aria-label="Tactic and Inverse source configurations" value={draft.strategyIndicationSources as string[]} onChange={e=>change('strategyIndicationSources',Array.from(e.target.selectedOptions,o=>o.value))}>{PORTED_CATALOG.map(s=><option key={s.id} value={s.id}>{s.label} · {s.id}</option>)}</select></label>
      </section>
      <section className="terminal-panel space-y-4 p-5" aria-label="Relational volume"><h3 className="text-sm font-semibold">Relational volume · Indications</h3><VolumeRatioSliders overall value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{indicationTypes:INDICATIONS,indications:draft.strategyIndicationSources as string[]}}/></section>
      <section className="terminal-panel space-y-4 p-5"><h3 className="text-sm font-semibold">Relational volume · Strategies & Ranges</h3><VolumeRatioSliders value={draft.relationalVolumeRatios} onChange={v=>change('relationalVolumeRatios',v)} buckets={{strategies:['normal','axis','block','dca'],ranges:RANGES}}/></section>
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
            <MultiChoice title="Stop-loss / take-profit ratio" description="Each ratio creates an independent configuration. SL distance = TP distance × ratio. Micro and Low-Range use 0.2–1.6 in 0.1 steps." values={RATIOS} selected={selected("strategySlRatios")} onChange={value => change("strategySlRatios", value)} format={value => Number(value).toFixed(1) + "×"} />
            <MultiChoice title="Exit modes" description="Fixed targets, trailing exits, and trailing-only each have their own configuration identity." values={MODES} selected={selected("strategyExitModes")} onChange={value => change("strategyExitModes", value)} />
            <MultiChoice title="Indications" description="Each selected indication evaluates its own configuration history." values={INDICATIONS} selected={selected("strategyIndicationTypes")} onChange={value => change("strategyIndicationTypes", value)} format={value => String(value).replaceAll("_", " ")} />
            <MultiChoice title="Trend & Break lookbacks" description="Separate indicator periods for the new Trend and Break families. Existing indications retain their original calculations." values={[10,14,20,40,60]} selected={selected('strategySignalPeriods')} onChange={value=>change('strategySignalPeriods',value)} />
            <MultiChoice title="Signal timeframes" description="10s lanes use recorded WebSocket trades only. Minute history never supplies 10s samples. Longer frames use completed native minutes; exits also process observed trades." values={[1/6,1,5,15,30]} selected={selected('strategySignalTimeframes')} onChange={value=>change('strategySignalTimeframes',value)} format={value=>Number(value)<1?'10s':value+'m'} />
          </section>
          <section className="terminal-panel p-5">
            <div className="mb-5 flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-[var(--terminal-accent)]" /><h3 className="text-sm font-semibold">Stage gates & completed evidence</h3></div>
            <p className="terminal-muted mb-5 text-xs">PF 1.0 is neutral. Each stage uses its own most recent completed samples. The Real gate controls progression into Live; exchange execution also requires a verified connection.</p>
            <div className="mb-5">{enumField("stageGateMode", "Stage progression", [{ value: "processed-sets", label: "Independent processed sets" }, { value: "continuous-ancestors", label: "Recheck all ancestor windows" }])}</div>
            <p className="terminal-muted mb-5 text-xs">Independent sets retain their admission proof and learn from their own new trades. Real remains the final current gate; Live mirrors fresh accepted Real entries. Changing mode starts separate downstream cohorts and preserves prior results.</p>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{NUMERIC_FIELDS.map(numberField)}</div>
            <label className="mt-5 flex items-center gap-3 text-xs"><input type="checkbox" checked={draft.autoPfEnabled===true} onChange={e=>change('autoPfEnabled',e.target.checked)}/>Auto PF by configuration TP distance</label>
            <p className="terminal-muted my-3 text-xs">Required PF = max(stage floor, min(cap, 1 + TP distance rounded down to 0.1% × slope)). Computed once per configuration; samples and losses remain unchanged.</p>
            <div className="grid gap-5 sm:grid-cols-2">{AUTO_PF_FIELDS.map(numberField)}</div>
            <label className="mt-5 flex items-center gap-3 text-xs"><input type="checkbox" checked={draft.microTradeStream===true} onChange={e=>change('microTradeStream',e.target.checked)}/>Record trades and 10-second history</label>
          </section>
        </div>
        <div className="space-y-5">
          <section className="terminal-panel p-5">
            <p className="terminal-muted text-[10px] uppercase tracking-[.18em]">Configuration preview</p><p className="mt-3 font-mono text-4xl font-semibold text-[var(--terminal-blue)]">{coreCount.toLocaleString()}</p><p className="terminal-muted mt-2 text-xs">Core configurations per symbol, before direction and coordination lanes.</p>
            <div className="mt-5 space-y-2 border-t border-[var(--terminal-border)] pt-4 text-xs"><p>{(draft.strategyEnabledRanges as string[]).join(" / ")}</p><p className="terminal-muted">{(draft.strategySlRatios as number[]).length} ratios × {(draft.strategyExitModes as string[]).length} exits × {(draft.strategyIndicationTypes as string[]).length} indications</p><p className={dirty ? "text-[var(--terminal-amber)]" : "terminal-muted"}>{dirty ? "Unsaved configuration" : "Saved values or labeled defaults"}</p></div>
          </section>
          <section className="terminal-panel space-y-5 p-5">
            <div><h3 className="text-sm font-semibold">Coordination lanes</h3><p className="terminal-muted mt-1 text-xs">Enable each additional evaluator independently.</p></div>
            {[
              ["axisPrevEnabled", "Axis", "History and outcome coordination"],
              ["variantBlockEnabled", "Block", "Block-based volume coordination"],
              ["variantDcaEnabled", "DCA", "Independent accumulation variant"],
            ].map(([key, label, description]) => <label key={key} className="flex cursor-pointer items-center justify-between gap-4 border-b border-[var(--terminal-border)] pb-3 last:border-0 last:pb-0"><span><span className="block text-xs font-medium">{label}</span><span className="terminal-muted mt-1 block text-[11px]">{description}{settings[key] === undefined ? " · default" : ""}</span></span><input type="checkbox" className="h-4 w-4 accent-cyan-400" checked={draft[key] === true} onChange={event => change(key, event.target.checked)} /></label>)}
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">Axis windows</h4><p className="terminal-muted text-xs leading-relaxed">Previous samples must meet the stage PF gate. The separate recent window must match the selected outcome. Both windows use the same configuration and direction of the selected Normal reference. Axis still needs its own completed evidence at every stage.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("axis")).map(numberField)}</div>{enumField("axisReferenceStage","Normal reference stage",[{value:'same-stage',label:'Matching stage'},{value:'base',label:'Continuous Base history'}])}{enumField("axisOutcome", "Recent net outcome", [{ value: "any", label: "Any outcome" }, { value: "positive", label: "Positive net result" }, { value: "negative", label: "Negative net result" }])}</div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">Block allocation</h4><p className="terminal-muted text-xs leading-relaxed">Rounds evaluate N completed positions independently per lane. After a losing round, the next round adds the base budget × ratio, up to the step and multiplier caps. The increased budget stays until net recovery, then pauses N rounds of eligible signals. Pyramid mode retains favorable-move additions.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("block")).map(numberField)}</div>{enumField("blockBehavior","Block calculation",[{value:"rounds",label:"Completed position rounds"},{value:"pyramid",label:"Favorable-move additions"}])}{draft.blockBehavior==="pyramid"&&enumField("blockMode", "Pyramid allocation mode", [{ value: "shared", label: "Shared budget" }, { value: "additive", label: "Additive exposure" }])}</div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">DCA allocation</h4><p className="terminal-muted text-xs leading-relaxed">Adds after the configured adverse move from the last fill. Each addition uses the base sizing budget × multiplier, up to the selected count.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("dca")).map(numberField)}</div></div>
          </section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Market universe & position sizing</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Scan up to this many available contracts. Base notional × volume factor sets the initial sizing budget before coordination adjustments and exchange rules.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{EXECUTION_FIELDS.map(numberField)}</div><p className="terminal-muted mt-5 border-t border-[var(--terminal-border)] pt-4 text-xs">Initial sizing budget: <span className="font-mono text-[var(--terminal-fg)]">{Number.isFinite(Number(draft.baseNotional) * Number(draft.volumeFactor)) ? (Number(draft.baseNotional) * Number(draft.volumeFactor)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"} USDT</span></p></section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Fee & slippage estimate</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Default taker 0.05% per side gives 0.10% round-trip fees; 10% fee-relative slippage gives 0.11% total modeled cost. The account’s exchange commission pair applies to the selected perpetual symbols. A failed refresh retains the last verified pair. Fee fields below apply when no verified pair is available. Slippage applies to the fee sum. Open positions retain their entry cost model.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{COST_FIELDS.map(numberField)}</div><details className="mt-5 text-xs"><summary className="cursor-pointer">Exchange fee coverage · {Object.keys(symbolFees).length} symbols</summary><p className="terminal-muted my-3">{!feeCheckedAt?"No startup commission check has been recorded.":feeReadFailures.length?`${feeReadFailures.length} symbol reads failed at the latest refresh. Cached pairs are labeled below; symbols without a known pair use configured fallbacks.`:"Latest startup commission reads completed without errors."}</p><div className="mt-3 max-h-60 overflow-auto"><table className="w-full text-left"><thead><tr><th>Symbol</th><th>Maker %</th><th>Taker %</th><th>Source</th></tr></thead><tbody>{Object.entries(symbolFees).map(([symbol,fee])=><tr key={symbol}><th className="py-1 font-normal">{symbol}</th><td>{fee.makerFeePct}</td><td>{fee.takerFeePct}</td><td>{feeReadFailures.includes(symbol)?"Last verified":feeCheckedAt?"Latest refresh":"Recorded"}</td></tr>)}</tbody></table></div></details></section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Ratios & distance factors</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Each lane budget = base notional × volume factor × lane ratio. TP = cost × step × TP factor. SL = TP × selected SL ratio × SL factor; trail = SL × trail ratio. Existing positions retain their captured settings. The order cap rejects exchange-rounded entries and adds above its value.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{FACTOR_FIELDS.map(numberField)}</div></section>
        </div>
      </div>
      </fieldset>
    </form>
    <CoordinationComparison rows={coordinationStats}/>
    <ReplayStudy key={connectionName} connectionId={connectionName==='x01'?'bingx-x01':'bingx-x02'} />
    </>
  )
}
