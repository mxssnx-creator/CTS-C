import {relationalVolumeSettings,DEFAULT_RELATIONAL_VOLUME} from "../shared/cts-volume/ratios.ts";
import { PORTED_CATALOG, DEFAULT_TACTIC_SOURCES, DEFAULT_INVERSE_SOURCES } from "../shared/cts-indications/catalog.ts"
import { strategyProcessing, validateProcessingByRange } from "./strategy-processing"
import { INDICATIONS as ALL_INDICATIONS, CORE_INDICATIONS,TECHNICAL_INDICATIONS } from "./indications"
import type { EngineSettings } from "./types"

export const RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide"]
export const RANGE_BOUNDS = [5, 8, 12, 18, 24, 30]
export const STEPS = Array.from({ length: 28 }, (_, index) => index + 3)
export const RATIOS = Array.from({ length: 11 }, (_, index) => Number(((index + 1) * 0.2).toFixed(1)))
export const BALANCED_STEPS = [3, 5, 8, 12, 18, 24, 30]
export const BALANCED_RATIOS = [0.6, 1, 1.4]
export const MODES = ["fixed", "trailing", "trailing-only"]
export const INDICATIONS = [...ALL_INDICATIONS]
export const DEFAULTS: Record<string, unknown> = {
  relationalVolumeRatios: structuredClone(DEFAULT_RELATIONAL_VOLUME), strategyNormalEnabled: true, strategyTrailingEnabled: true, strategyProcessingByRange: {},
  stageGateMode: "continuous-ancestors",
  baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1,
  mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20,
  variantBlockEnabled: true, variantDcaEnabled: true, axisPrevEnabled: true,
  axisPrevious: 8, axisLast: 3, axisOutcome: "any",axisReferenceStage:'same-stage',
  blockSteps: 3, blockMode: "shared", dcaSteps: 2, dcaDistancePct: 1, dcaMultiplier: 2,
  normalVolumeRatio: 1, axisVolumeRatio: 1, blockVolumeFactor: 1, dcaVolumeRatio: 1, maxOrderNotional: 0,
  strategyTpFactor: 1, strategySlFactor: 1, strategyTrailRatio: 1, holdTimeFactor: 1,
  blockVolumeRatio: 0.2, makerFeePct: 0.05, takerFeePct: 0.08, slippagePctOfFees: 10,
  symbolCount: 100, historyCandles: 1440, volumeFactor: 0.01, baseNotional: 100,
  strategyEnabledRanges: RANGES, strategyTpSteps: BALANCED_STEPS, strategySlRatios: BALANCED_RATIOS,
  strategyExitModes: MODES, strategyIndicationTypes: [...CORE_INDICATIONS],
  strategyIndicationSources:[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES],
  strategySignalPeriods:[20],strategySignalTimeframes:[1],
}
export const NUMERIC_FIELDS = [
  { key: "baseProfitFactor", label: "Base → Main minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "mainProfitFactor", label: "Main → Real minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "realProfitFactor", label: "Real → Live minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "prevPosWindow", label: "Base completed samples", min: 1, max: 250, step: 1 },
  { key: "mainEvalPosCount", label: "Main completed samples", min: 1, max: 250, step: 1 },
  { key: "realEvalPosCount", label: "Real completed samples", min: 1, max: 250, step: 1 },
]
export const COST_FIELDS = [
  { key: "makerFeePct", label: "Maker fee (%)", min: 0, max: 20, step: 0.001 },
  { key: "takerFeePct", label: "Taker fee (%)", min: 0, max: 20, step: 0.001 },
  { key: "slippagePctOfFees", label: "Slippage (% of fees)", min: 0, max: 100, step: 0.1 },
]
export const COORDINATION_FIELDS = [
  { key: "axisPrevious", label: "Axis previous samples", min: 1, max: 250, step: 1 },
  { key: "axisLast", label: "Axis recent samples", min: 1, max: 250, step: 1 },
  { key: "blockSteps", label: "Block additions", min: 1, max: 20, step: 1 },
  { key: "blockVolumeRatio", label: "Block volume ratio", min: 0.01, max: 10, step: 0.01 },
  { key: "dcaSteps", label: "DCA additions", min: 1, max: 20, step: 1 },
  { key: "dcaDistancePct", label: "DCA adverse distance (%)", min: 0.001, max: 100, step: 0.001 },
  { key: "dcaMultiplier", label: "DCA addition multiplier", min: 0.01, max: 10, step: 0.01 },
]
const ENUM_FIELDS: Record<string, readonly string[]> = { stageGateMode:['continuous-ancestors','processed-sets'],axisReferenceStage:['base','same-stage'],axisOutcome: ["any", "positive", "negative"], blockMode: ["shared", "additive"] }
export const EXECUTION_FIELDS = [
  { key: "maxOrderNotional", label: "Maximum order notional (0 = disabled)", min: 0, max: 1_000_000_000, step: 0.001 },
  { key: "symbolCount", label: "Symbols to scan", min: 1, max: 500, step: 1 },
  { key: "historyCandles", label: "Warm-up candles per symbol", min: 100, max: 1440, step: 1 },
  { key: "baseNotional", label: "Base notional (USDT)", min: 0.000001, max: 1_000_000_000, step: 0.000001 },
  { key: "volumeFactor", label: "Volume factor", min: 0.000001, max: 100, step: 0.000001 },
]
const ARRAY_FIELDS: Record<string, readonly (string | number)[]> = {
  strategyEnabledRanges: RANGES, strategyTpSteps: STEPS, strategySlRatios: RATIOS,
  strategyExitModes: MODES, strategyIndicationTypes: INDICATIONS,
  strategyIndicationSources:PORTED_CATALOG.map(s=>s.id),
  strategySignalPeriods:[10,14,20,40,60],strategySignalTimeframes:[1,5,15,30],
}
export const FACTOR_FIELDS = [
  { key: "normalVolumeRatio", label: "Normal budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "axisVolumeRatio", label: "Axis budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "blockVolumeFactor", label: "Block budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "dcaVolumeRatio", label: "DCA budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "strategyTpFactor", label: "TP distance factor", min: 0.05, max: 10, step: 0.05 },
  { key: "strategySlFactor", label: "SL / TP ratio factor", min: 0.05, max: 10, step: 0.05 },
  { key: "strategyTrailRatio", label: "Trail / SL distance ratio", min: 0.05, max: 10, step: 0.05 },
  { key: "holdTimeFactor", label: "Maximum hold factor", min: 0.05, max: 10, step: 0.05 },
]
export const ALL_NUMERIC_FIELDS = [...NUMERIC_FIELDS, ...COST_FIELDS, ...EXECUTION_FIELDS, ...COORDINATION_FIELDS, ...FACTOR_FIELDS]

export function configurationCount(values: Record<string, unknown>) {
  const ranges = values.strategyEnabledRanges as string[]
  const steps = (values.strategyTpSteps as number[]).filter(step => ranges.includes(RANGES[RANGE_BOUNDS.findIndex(bound => step <= bound)]))
  const types=values.strategyIndicationTypes as string[],technical=types.filter(t=>(TECHNICAL_INDICATIONS as readonly string[]).includes(t)).length
  const cells = steps.reduce((sum, step) => {
    const range = RANGES[RANGE_BOUNDS.findIndex(bound => step <= bound)] as import("./types").StrategyRange
    const modes = (values.strategyExitModes as string[]).filter(mode => mode === "fixed" || strategyProcessing(values, {range}).trailing)
    return sum + modes.length
  }, 0)
  const portedTypes=types.filter(t=>t==='Tactic'||t==='Inverse')
  const sourceIds=values.strategyIndicationSources as string[]
  const extra=portedTypes.reduce((n,t)=>n+sourceIds.filter(id=>PORTED_CATALOG.some(s=>s.id===id&&s.kind===t.toLowerCase())).length*(values.strategySignalTimeframes as number[]).filter(tf=>t!=='Inverse'||tf!==30).length,0)
  return cells * (values.strategySlRatios as number[]).length * (types.length-technical-portedTypes.length+extra+technical*(values.strategySignalPeriods as number[]).length*(values.strategySignalTimeframes as number[]).length)
}

export function validateConfiguration(input: unknown, { partial = false, formNumbers = false } = {}): Record<string, unknown> {
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
    if (key === "relationalVolumeRatios") {
      output[key]=relationalVolumeSettings(value,true)
    } else if (key === "strategyProcessingByRange") {
      output[key] = validateProcessingByRange(value)
    } else if (arrayOptions) {
      if (!Array.isArray(value) || !value.length || value.some(item => !arrayOptions.includes(item)) || new Set(value).size !== value.length) throw new Error(`Choose valid, unique values for ${key}.`)
      output[key] = [...value]
    } else if (enumOptions) {
      if (typeof value !== "string" || !enumOptions.includes(value)) throw new Error(`Choose a valid ${key === "axisOutcome" ? "Axis outcome" : key === "stageGateMode" ? "stage gate mode" : key === "axisReferenceStage" ? "Axis reference stage" : "Block allocation mode"}.`)
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
    if (output.axisPrevEnabled && Number(output.axisPrevious) + Number(output.axisLast) > 250) throw new Error("Axis previous and recent windows must total 250 samples or fewer.")
    if (configurationCount(output) === 0) throw new Error("Choose at least one TP step within your selected ranges.")
  }
  return output
}

export function hydrate(settings: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (settings[key] === undefined) continue
    if (key === "relationalVolumeRatios") {
      try{result[key]=relationalVolumeSettings(JSON.parse(settings[key]),true)}catch{}
    } else if (key === "strategyProcessingByRange") {
      try { result[key] = validateProcessingByRange(JSON.parse(settings[key])) } catch { /* Preserve defaults on invalid legacy data. */ }
    } else if (Array.isArray(fallback)) {
      try { const parsed: unknown = JSON.parse(settings[key]); if (Array.isArray(parsed) && parsed.length) result[key] = parsed } catch { /* Keep a visible default for an invalid saved value. */ }
    } else if (typeof fallback === "boolean") result[key] = settings[key] === "true" || settings[key] === "1"
    else if (typeof fallback === "string") { if (ENUM_FIELDS[key]?.includes(settings[key])) result[key] = settings[key] }
    else { const number = Number(settings[key]); if (Number.isFinite(number)) result[key] = number }
  }
  return result
}

/** The same editable schema is used by forms, JSON imports and server writes. */
export function flatEngineSettings(s:EngineSettings,control:{symbolCount:number;historyCandles:number}):Record<string,unknown>{
  const values:Record<string,unknown>={...structuredClone(DEFAULTS)}
  for(const [key,value] of Object.entries(s.catalog))if(Object.hasOwn(DEFAULTS,key))values[key]=value
  return {...values,stageGateMode:s.stageGateMode??'continuous-ancestors',symbolCount:control.symbolCount,historyCandles:control.historyCandles,volumeFactor:s.volumeFactor,baseNotional:s.baseNotional,maxOrderNotional:s.maxOrderNotional??0,
    normalVolumeRatio:s.volumeRatios?.normal??1,axisVolumeRatio:s.volumeRatios?.axis??1,blockVolumeFactor:s.volumeRatios?.block??1,dcaVolumeRatio:s.volumeRatios?.dca??1,
    prevPosWindow:s.stageLastN.base,mainEvalPosCount:s.stageLastN.main,realEvalPosCount:s.stageLastN.real,
    baseProfitFactor:s.stageMinPF.base,mainProfitFactor:s.stageMinPF.main,realProfitFactor:s.stageMinPF.real,
    variantBlockEnabled:s.coordinations.block.enabled,variantDcaEnabled:s.coordinations.dca.enabled,axisPrevEnabled:s.coordinations.axis.enabled,
    blockVolumeRatio:s.coordinations.block.ratio,axisPrevious:s.coordinations.axis.previous,axisLast:s.coordinations.axis.last,axisOutcome:s.coordinations.axis.outcome,axisReferenceStage:s.coordinations.axis.reference??'same-stage',
    blockSteps:s.coordinations.block.steps,blockMode:s.coordinations.block.mode,dcaSteps:s.coordinations.dca.steps,dcaDistancePct:s.coordinations.dca.distancePct,dcaMultiplier:s.coordinations.dca.multiplier}
}

