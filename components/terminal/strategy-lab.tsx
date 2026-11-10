"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Download, Layers3, RotateCcw, Save, SlidersHorizontal, Upload } from "lucide-react"
import { ReplayStudy } from "./replay-study"
import { INDICATIONS as ALL_INDICATIONS, CORE_INDICATIONS } from "@/core/indications"

const RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide"]
const RANGE_BOUNDS = [5, 8, 12, 18, 24, 30]
const STEPS = Array.from({ length: 28 }, (_, index) => index + 3)
const RATIOS = Array.from({ length: 11 }, (_, index) => Number(((index + 1) * 0.2).toFixed(1)))
const BALANCED_STEPS = [3, 5, 8, 12, 18, 24, 30]
const BALANCED_RATIOS = [0.6, 1, 1.4]
const MODES = ["fixed", "trailing", "trailing-only"]
const INDICATIONS = [...ALL_INDICATIONS]
const DEFAULTS: Record<string, unknown> = {
  baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1,
  mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20,
  variantBlockEnabled: true, variantDcaEnabled: true, axisPrevEnabled: true,
  axisPrevious: 8, axisLast: 3, axisOutcome: "any",
  blockSteps: 3, blockMode: "shared", dcaSteps: 2, dcaDistancePct: 1, dcaMultiplier: 2,
  blockVolumeRatio: 0.2, makerFeePct: 0.05, takerFeePct: 0.08, slippagePctOfFees: 10,
  symbolCount: 100, historyCandles: 1440, volumeFactor: 0.01, baseNotional: 100,
  strategyEnabledRanges: RANGES, strategyTpSteps: BALANCED_STEPS, strategySlRatios: BALANCED_RATIOS,
  strategyExitModes: MODES, strategyIndicationTypes: [...CORE_INDICATIONS],
}
const NUMERIC_FIELDS = [
  { key: "baseProfitFactor", label: "Base → Main minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "mainProfitFactor", label: "Main → Real minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "realProfitFactor", label: "Real → Live minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "prevPosWindow", label: "Base completed samples", min: 1, max: 250, step: 1 },
  { key: "mainEvalPosCount", label: "Main completed samples", min: 1, max: 250, step: 1 },
  { key: "realEvalPosCount", label: "Real completed samples", min: 1, max: 250, step: 1 },
]
const COST_FIELDS = [
  { key: "makerFeePct", label: "Maker fee (%)", min: 0.001, max: 20, step: 0.001 },
  { key: "takerFeePct", label: "Taker fee (%)", min: 0.001, max: 20, step: 0.001 },
  { key: "slippagePctOfFees", label: "Slippage (% of fees)", min: 0.1, max: 100, step: 0.1 },
]
const COORDINATION_FIELDS = [
  { key: "axisPrevious", label: "Axis previous samples", min: 1, max: 250, step: 1 },
  { key: "axisLast", label: "Axis recent samples", min: 1, max: 250, step: 1 },
  { key: "blockSteps", label: "Block additions", min: 1, max: 20, step: 1 },
  { key: "blockVolumeRatio", label: "Block volume ratio", min: 0.01, max: 10, step: 0.01 },
  { key: "dcaSteps", label: "DCA additions", min: 1, max: 20, step: 1 },
  { key: "dcaDistancePct", label: "DCA adverse distance (%)", min: 0.001, max: 100, step: 0.001 },
  { key: "dcaMultiplier", label: "DCA addition multiplier", min: 0.01, max: 10, step: 0.01 },
]
const ENUM_FIELDS: Record<string, readonly string[]> = { axisOutcome: ["any", "positive", "negative"], blockMode: ["shared", "additive"] }
const EXECUTION_FIELDS = [
  { key: "symbolCount", label: "Symbols to scan", min: 1, max: 500, step: 1 },
  { key: "historyCandles", label: "Warm-up candles per symbol", min: 100, max: 1440, step: 1 },
  { key: "baseNotional", label: "Base notional (USDT)", min: 0.000001, max: 1_000_000_000, step: 0.000001 },
  { key: "volumeFactor", label: "Volume factor", min: 0.000001, max: 100, step: 0.000001 },
]
const ARRAY_FIELDS: Record<string, readonly (string | number)[]> = {
  strategyEnabledRanges: RANGES, strategyTpSteps: STEPS, strategySlRatios: RATIOS,
  strategyExitModes: MODES, strategyIndicationTypes: INDICATIONS,
}
const ALL_NUMERIC_FIELDS = [...NUMERIC_FIELDS, ...COST_FIELDS, ...EXECUTION_FIELDS, ...COORDINATION_FIELDS]

function configurationCount(values: Record<string, unknown>) {
  const ranges = values.strategyEnabledRanges as string[]
  const steps = (values.strategyTpSteps as number[]).filter(step => ranges.includes(RANGES[RANGE_BOUNDS.findIndex(bound => step <= bound)]))
  return steps.length * (values.strategySlRatios as number[]).length * (values.strategyExitModes as string[]).length * (values.strategyIndicationTypes as string[]).length
}

function validateConfiguration(input: unknown, { partial = false, formNumbers = false } = {}): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Configuration must be a plain JSON object containing editable settings.")
  const values = input as Record<string, unknown>
  const keys = Object.keys(values)
  if (!keys.length) throw new Error("Configuration does not contain any settings.")
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(DEFAULTS, key))) throw new Error("Configuration contains unsupported fields. Only editable strategy settings are allowed; credentials and authentication fields cannot be imported.")
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      if (partial) continue
      throw new Error(`Configuration is missing ${key}.`)
    }
    const value = values[key]
    const arrayOptions = ARRAY_FIELDS[key]
    const enumOptions = ENUM_FIELDS[key]
    const field = ALL_NUMERIC_FIELDS.find(item => item.key === key)
    if (arrayOptions) {
      if (!Array.isArray(value) || !value.length || value.some(item => !arrayOptions.includes(item)) || new Set(value).size !== value.length) throw new Error(`Choose valid, unique values for ${key}.`)
      output[key] = [...value]
    } else if (enumOptions) {
      if (typeof value !== "string" || !enumOptions.includes(value)) throw new Error(`Choose a valid ${key === "axisOutcome" ? "Axis outcome" : "Block allocation mode"}.`)
      output[key] = value
    } else if (field) {
      const number = formNumbers && typeof value === "string" && value.trim() !== "" ? Number(value) : value
      if (typeof number !== "number" || !Number.isFinite(number) || number < field.min || number > field.max || (field.step === 1 && !Number.isInteger(number))) throw new Error(`Enter a valid ${field.label.toLowerCase()}.`)
      output[key] = number
    } else {
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`)
      output[key] = value
    }
  }
  if (!partial) {
    if (Number(output.axisPrevious) + Number(output.axisLast) > 250) throw new Error("Axis previous and recent windows must total 250 samples or fewer.")
    if (configurationCount(output) === 0) throw new Error("Choose at least one TP step within your selected ranges.")
  }
  return output
}

function hydrate(settings: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (settings[key] === undefined) continue
    if (Array.isArray(fallback)) {
      try { const parsed: unknown = JSON.parse(settings[key]); if (Array.isArray(parsed) && parsed.length) result[key] = parsed } catch { /* Keep a visible default for an invalid saved value. */ }
    } else if (typeof fallback === "boolean") result[key] = settings[key] === "true" || settings[key] === "1"
    else if (typeof fallback === "string") { if (ENUM_FIELDS[key]?.includes(settings[key])) result[key] = settings[key] }
    else { const number = Number(settings[key]); if (Number.isFinite(number)) result[key] = number }
  }
  return result
}

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

export function StrategyLab({ settings, onSave, busy }: { settings: Record<string, string>; onSave: (settings: Record<string, unknown>) => Promise<void>; busy: boolean }) {
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
    const name = kind === "micro" ? "Micro + Minimal" : kind === "balanced" ? "Balanced" : "Full catalog"
    dirtyRef.current = true; setDirty(true); setError(null); setMessage(`${name} preset prepared. Save to apply it to x02.`)
    setDraft(current => ({ ...current, strategyEnabledRanges: kind === "micro" ? ["Micro", "Minimal"] : [...RANGES],
      strategyTpSteps: kind === "micro" ? [3, 4, 5, 6, 7, 8] : kind === "balanced" ? [...BALANCED_STEPS] : [...STEPS],
      strategySlRatios: kind === "balanced" ? [...BALANCED_RATIOS] : [...RATIOS], strategyExitModes: [...MODES], strategyIndicationTypes: kind==="full"?[...INDICATIONS]:[...CORE_INDICATIONS],
      baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1,
      mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20 }))
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setMessage(null)
    let output: Record<string, unknown>
    try { output = validateConfiguration(draft, { formNumbers: true }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid configuration."); return }
    setSaving(true)
    try { await onSave(output); dirtyRef.current = false; setDirty(false); setMessage("Strategy configuration saved to x02.") }
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
      <div className="terminal-panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div><p className="terminal-muted text-[10px] uppercase tracking-[.2em]">X02 / Configuration studio</p><h2 className="mt-1 text-xl font-semibold">Independent strategy combinations</h2><p className="terminal-muted mt-2 max-w-2xl text-xs leading-relaxed">Ranges, distances, exit modes, and indications generate separate core configurations. Axis, Block, and DCA coordinate their progression.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => preset("balanced")} className="terminal-button" disabled={busy || saving}>Balanced · 252</button>
          <button type="button" onClick={() => preset("micro")} className="terminal-button" disabled={busy || saving}><Layers3 className="mr-2 inline h-4 w-4" />Micro + Minimal</button>
          <button type="button" onClick={() => preset("full")} className="terminal-button" disabled={busy || saving}>Full · 7,392</button>
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
            <MultiChoice title="Strategy ranges" description="Micro 3–5 · Minimal 6–8 · Short 9–12 · Normal 13–18 · Long 19–24 · Wide 25–30 TP steps." values={RANGES} selected={selected("strategyEnabledRanges")} onChange={value => change("strategyEnabledRanges", value)} />
            <MultiChoice title="Take-profit steps" description="TP distance = estimated round-trip position cost × selected step. Only steps within enabled ranges produce configurations." values={STEPS} selected={selected("strategyTpSteps")} onChange={value => change("strategyTpSteps", value)} />
            <MultiChoice title="Stop-loss / take-profit ratio" description="Each ratio creates an independent configuration. SL distance = TP distance × ratio." values={RATIOS} selected={selected("strategySlRatios")} onChange={value => change("strategySlRatios", value)} format={value => Number(value).toFixed(1) + "×"} />
            <MultiChoice title="Exit modes" description="Fixed targets, trailing exits, and trailing-only each have their own configuration identity." values={MODES} selected={selected("strategyExitModes")} onChange={value => change("strategyExitModes", value)} />
            <MultiChoice title="Indications" description="Each selected indication evaluates its own configuration history." values={INDICATIONS} selected={selected("strategyIndicationTypes")} onChange={value => change("strategyIndicationTypes", value)} format={value => String(value).replaceAll("_", " ")} />
          </section>
          <section className="terminal-panel p-5">
            <div className="mb-5 flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-[var(--terminal-accent)]" /><h3 className="text-sm font-semibold">Stage gates & completed evidence</h3></div>
            <p className="terminal-muted mb-5 text-xs">PF 1.0 is neutral. Each stage uses its own most recent completed samples. The Real gate controls progression into Live; exchange execution also requires a verified connection.</p>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{NUMERIC_FIELDS.map(numberField)}</div>
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
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">Axis windows</h4><p className="terminal-muted text-xs leading-relaxed">Previous samples must meet the stage PF gate. The separate recent window must match the selected outcome. Both windows use the matching normal lane.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("axis")).map(numberField)}</div>{enumField("axisOutcome", "Recent net outcome", [{ value: "any", label: "Any outcome" }, { value: "positive", label: "Positive net result" }, { value: "negative", label: "Negative net result" }])}</div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">Block allocation</h4><p className="terminal-muted text-xs leading-relaxed">Adds after favorable moves. Shared mode divides one sizing budget across entry and additions; additive mode increases total exposure with each addition.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("block")).map(numberField)}</div>{enumField("blockMode", "Allocation mode", [{ value: "shared", label: "Shared budget" }, { value: "additive", label: "Additive exposure" }])}</div>
            <div className="space-y-4 border-t border-[var(--terminal-border)] pt-5"><h4 className="text-xs font-semibold">DCA allocation</h4><p className="terminal-muted text-xs leading-relaxed">Adds after the configured adverse move from the last fill. Each addition uses the base sizing budget × multiplier, up to the selected count.</p><div className="grid gap-4 sm:grid-cols-2">{COORDINATION_FIELDS.filter(field => field.key.startsWith("dca")).map(numberField)}</div></div>
          </section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Market universe & position sizing</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Scan up to this many available contracts. Base notional × volume factor sets the initial sizing budget before coordination adjustments and exchange rules.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{EXECUTION_FIELDS.map(numberField)}</div><p className="terminal-muted mt-5 border-t border-[var(--terminal-border)] pt-4 text-xs">Initial sizing budget: <span className="font-mono text-[var(--terminal-fg)]">{Number.isFinite(Number(draft.baseNotional) * Number(draft.volumeFactor)) ? (Number(draft.baseNotional) * Number(draft.volumeFactor)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"} USDT</span></p></section>
          <section className="terminal-panel p-5"><h3 className="mb-2 text-sm font-semibold">Fee & slippage estimate</h3><p className="terminal-muted mb-5 text-xs leading-relaxed">Percent units: 0.08 means 0.08%. Fee inputs define the strategy cost estimate.</p><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">{COST_FIELDS.map(numberField)}</div></section>
        </div>
      </div>
      </fieldset>
    </form>
    <ReplayStudy />
    </>
  )
}
