import { checkStageCoordinations } from "./stage-branches"
import {checkBlockPolicy,type BlockPolicy} from "../shared/cts-lastn/blocks.ts";
import {relationalVolumeSettings,DEFAULT_RELATIONAL_VOLUME} from "../shared/cts-volume/ratios.ts";
import { PORTED_CATALOG, DEFAULT_TACTIC_SOURCES, DEFAULT_INVERSE_SOURCES } from "../shared/cts-indications/catalog.ts"
import {SIGNALS_CATALOG,DEFAULT_SIGNALS_SOURCES} from '../shared/cts-indications/signals-catalog'
import { strategyProcessing, validateProcessingByRange } from "./strategy-processing"
import { INDICATIONS as ALL_INDICATIONS, CORE_INDICATIONS, CORE_SIGNAL_PERIODS, indicationPeriods } from "./indications"
import { DEFAULT_EXIT_MODES, EXIT_MODES, type EngineSettings, type ExitMode, type StrategyRange } from "./types"
import { EXPANDED_CATALOG_MAX, STOP_DISTANCE_PCTS, TRAIL_DISTANCE_PCTS, SELECTABLE_STOP_DISTANCE_PCTS, SELECTABLE_TRAIL_DISTANCE_PCTS, protectionVariants } from "./protection-grid"
import { LAST_N_STAGES, DEFAULT_EXEC_MIN_PF, DEFAULT_EXEC_WINDOWS, checkExecWindows, checkLastNGrid, lastNVariantCount, type LastNGrid } from "./last-n-grid"
import { DEFAULT_LOW_RANGE_SOURCES, LOW_RANGE_IDS, LOW_RANGE_STEPS, LOW_RANGE_TIMEFRAMES } from "../shared/cts-indications/low-range-catalog.ts"
import { DEFAULT_STEP_AUTO } from "./step-evidence"
import { DEFAULT_RELATE } from "./relate"
import { AUTO_PF_DEFAULTS, autoPfPolicy } from "./auto-pf"
import { RESEARCH_TACTIC_SOURCES, SIGNAL_TIMEFRAMES, supportsTacticTimeframe } from "../shared/cts-indications/research-sources"
import { MAX_WARMUP_CANDLES } from "./history"
import { EXEC_PROFILES } from "./exec-profile"

export const RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide", "Low-Range"]
export const RANGE_BOUNDS = [5, 8, 12, 18, 24, 30]
export const STEPS = Array.from({ length: 29 }, (_, index) => index + 2)
export const RATIOS = Array.from({ length: 21 }, (_, index) => Number(((index + 2) * 0.1).toFixed(1)))
export const BALANCED_STEPS = [3, 5, 8, 12, 18, 24, 30]
export const BALANCED_RATIOS = [0.6, 1, 1.4]
export const MODES = [...EXIT_MODES]
export const INDICATIONS = [...ALL_INDICATIONS]
export const DEFAULTS: Record<string, unknown> = {
  relationalVolumeRatios: structuredClone(DEFAULT_RELATIONAL_VOLUME), strategyNormalEnabled: true, strategyTrailingEnabled: true, strategyProcessingByRange: {},
  stageGateMode: "exec-branches",
  ...Object.fromEntries(EXEC_PROFILES.map(profile=>[profile.setting,true])),
  stageWindowScope: "context", microStageWindowScope: "inherit",
  stageBlocks: {}, strategyLastNGrid: {}, strategyExecWindows: DEFAULT_EXEC_WINDOWS, strategyStageCoordinations: {},
  liveEntryMode: "independent",
  baseProfitFactor: 1.1, mainProfitFactor: 1.1, realProfitFactor: 1.1, execMinPF: DEFAULT_EXEC_MIN_PF,
  mainEvalPosCount: 8, realEvalPosCount: 8, prevPosWindow: 20,
  variantBlockEnabled: true, variantDcaEnabled: true, axisPrevEnabled: true,
  axisPrevious: 8, axisLast: 3, axisOutcome: "any",axisReferenceStage:'same-stage',
  blockBehavior: "pyramid", blockSize: 3, blockPauseRounds: 1, blockMaxMultiplier: 3,
  ...AUTO_PF_DEFAULTS, microTradeStream: false,
  strategyPriceDistancesEnabled: false, strategyStopDistancePcts: STOP_DISTANCE_PCTS, strategyTrailDistancePcts: TRAIL_DISTANCE_PCTS,
  blockSteps: 3, blockMode: "shared", dcaSteps: 2, dcaDistancePct: 1, dcaMultiplier: 2,
  blockAutoEnabled: DEFAULT_STEP_AUTO.enabled, blockAutoLastN: DEFAULT_STEP_AUTO.lastN,
  blockAutoMinSamples: DEFAULT_STEP_AUTO.minSamples, blockAutoMinPF: DEFAULT_STEP_AUTO.minPF,
  dcaAutoEnabled: DEFAULT_STEP_AUTO.enabled, dcaAutoLastN: DEFAULT_STEP_AUTO.lastN,
  dcaAutoMinSamples: DEFAULT_STEP_AUTO.minSamples, dcaAutoMinPF: DEFAULT_STEP_AUTO.minPF,
  relateEnabled: DEFAULT_RELATE.enabled, relateSteps: DEFAULT_RELATE.steps, relateRatio: DEFAULT_RELATE.ratio,
  relateLastN: DEFAULT_RELATE.lastN, relateMinTrades: DEFAULT_RELATE.minTrades, relateMinPF: DEFAULT_RELATE.minPF,
  relateMaxMultiplier: DEFAULT_RELATE.maxMultiplier, relateMaxSlRatio: DEFAULT_RELATE.maxSlRatio,
  normalVolumeRatio: 1, axisVolumeRatio: 1, blockVolumeFactor: 1, dcaVolumeRatio: 1, relateVolumeRatio: 1, maxOrderNotional: 0,
  microTrailRatio: .5, microMinSlDistancePct: .1, microMinTrailDistancePct: .05, strategyTpFactor: 1, strategySlFactor: 1, strategyTrailRatio: 1, holdTimeFactor: 1,
  blockVolumeRatio: 0.2, makerFeePct: 0.02, takerFeePct: 0.05, slippagePctOfFees: 10,
  symbolCount: 100, historyCandles: 4320, volumeFactor: 0.01, baseNotional: 100,
  strategyEnabledRanges: RANGES.filter(r=>r!=="Low-Range"), strategyTpSteps: BALANCED_STEPS, strategySlRatios: BALANCED_RATIOS,
  strategyExitModes: [...DEFAULT_EXIT_MODES], strategyIndicationTypes: [...CORE_INDICATIONS],
  strategyIndicationSources:[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES],
  strategyLowRangeSources:[...DEFAULT_LOW_RANGE_SOURCES],
  strategySignalPeriods:[20],strategyCoreSignalPeriods:[0],strategySignalTimeframes:[1],
  strategySignalsSources:[...DEFAULT_SIGNALS_SOURCES],signalsMaxWindowDrawdownPct:3,
}
export const NUMERIC_FIELDS = [
  { key: "baseProfitFactor", label: "Base → Main minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "mainProfitFactor", label: "Main → Real minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "realProfitFactor", label: "Real minimum PF", min: 0, max: 999, step: 0.01 },
  { key: "prevPosWindow", label: "Base completed samples", min: 1, max: 250, step: 1 },
  { key: "mainEvalPosCount", label: "Main completed samples", min: 1, max: 250, step: 1 },
  { key: "realEvalPosCount", label: "Real completed samples", min: 1, max: 250, step: 1 },
]
export const EXEC_PF_FIELD = { key: "execMinPF", label: "Exec → Live minimum PF", min: 1.01, max: 999, step: 0.01 }
export const COST_FIELDS = [
  { key: "makerFeePct", label: "Maker fee (%)", min: 0, max: 20, step: 0.001 },
  { key: "takerFeePct", label: "Taker fee (%)", min: 0, max: 20, step: 0.001 },
  { key: "slippagePctOfFees", label: "Slippage (% of fees)", min: 0, max: 100, step: 0.1 },
]
export const AUTO_PF_FIELDS = [
  {key:"autoPfFallback",label:"Sparse-history PF floor",min:1.01,max:10,step:.01},
  {key:"autoPfMinSamples",label:"Minimum prior closes per Set",min:3,max:250,step:1},
  {key:"autoPfHistory",label:"Maximum prior closes per Set",min:3,max:250,step:1},
  {key:"autoPfAdjustment",label:"Adjustment for weak prior PF",min:0,max:4,step:.05},
  {key:"autoPfRatio",label:"Legacy PF slope per 1% TP",min:0,max:2,step:.05},
  {key:"autoPfMax",label:"Auto PF maximum",min:1.01,max:10,step:.01},
]
export const COORDINATION_FIELDS = [
  {key:"blockSize",label:"Positions per Block round",min:1,max:100,step:1},
  {key:"blockPauseRounds",label:"Pause rounds after net recovery",min:0,max:100,step:1},
  {key:"blockMaxMultiplier",label:"Maximum Block budget multiplier",min:1,max:10,step:.1},
  { key: "axisPrevious", label: "Axis previous samples", min: 1, max: 250, step: 1 },
  { key: "axisLast", label: "Axis recent samples", min: 1, max: 250, step: 1 },
  { key: "blockSteps", label: "Block maximum increase steps", min: 1, max: 20, step: 1 },
  { key: "blockVolumeRatio", label: "Block volume ratio", min: 0.01, max: 10, step: 0.01 },
  { key: "blockAutoLastN", label: "Block Auto recent observations", min: 3, max: 100, step: 1 },
  { key: "blockAutoMinSamples", label: "Block Auto minimum observations", min: 3, max: 100, step: 1 },
  { key: "blockAutoMinPF", label: "Block Auto minimum raise PF", min: 1.01, max: 10, step: .01 },
  { key: "dcaSteps", label: "DCA additions", min: 1, max: 20, step: 1 },
  { key: "dcaDistancePct", label: "DCA adverse distance (%)", min: 0.001, max: 100, step: 0.001 },
  { key: "dcaMultiplier", label: "DCA addition multiplier", min: 0.01, max: 10, step: 0.01 },
  { key: "dcaAutoLastN", label: "DCA Auto recent observations", min: 3, max: 100, step: 1 },
  { key: "dcaAutoMinSamples", label: "DCA Auto minimum observations", min: 3, max: 100, step: 1 },
  { key: "dcaAutoMinPF", label: "DCA Auto minimum add PF", min: 1.01, max: 10, step: .01 },
  { key: "relateSteps", label: "Relate winning steps", min: 2, max: 15, step: 1 },
  { key: "relateRatio", label: "Relate increase per step", min: .2, max: 6, step: .2 },
  { key: "relateLastN", label: "Relate recent samples", min: 60, max: 250, step: 1 },
  { key: "relateMinTrades", label: "Relate minimum samples", min: 60, max: 250, step: 1 },
  { key: "relateMinPF", label: "Relate minimum PF", min: 1.01, max: 100, step: .01 },
  { key: "relateMaxMultiplier", label: "Relate maximum multiplier", min: 1, max: 8, step: .1 },
  { key: "relateMaxSlRatio", label: "Relate maximum SL-to-TP ratio", min: .01, max: .5, step: .01 },
]
const WINDOW_SCOPES = ["context", "config", "both"] as const
const ENUM_FIELDS: Record<string, readonly string[]> = { autoPfMode:["set-history","tp-distance"],blockBehavior:["pyramid","rounds"],liveEntryMode:['independent','real-mirror'],stageGateMode:['continuous-ancestors','processed-sets','parent-branches','exec-branches'],stageWindowScope:WINDOW_SCOPES,microStageWindowScope:["inherit",...WINDOW_SCOPES],axisReferenceStage:['base','same-stage'],axisOutcome: ["any", "positive", "negative"], blockMode: ["shared", "additive"] }
export const EXECUTION_FIELDS = [
  { key: "maxOrderNotional", label: "Maximum order notional (0 = disabled)", min: 0, max: 1_000_000_000, step: 0.001 },
  { key: "symbolCount", label: "Symbols to scan", min: 1, max: 500, step: 1 },
  { key: "historyCandles", label: "Warm-up candles per symbol", min: 100, max: MAX_WARMUP_CANDLES, step: 1 },
  { key: "baseNotional", label: "Base notional (USDT)", min: 0.000001, max: 1_000_000_000, step: 0.000001 },
  { key: "volumeFactor", label: "Volume factor", min: 0.000001, max: 100, step: 0.000001 },
]
const ARRAY_FIELDS: Record<string, readonly (string | number)[]> = {
  strategyEnabledRanges: RANGES, strategyTpSteps: STEPS, strategySlRatios: RATIOS,
  strategyStopDistancePcts: SELECTABLE_STOP_DISTANCE_PCTS, strategyTrailDistancePcts: SELECTABLE_TRAIL_DISTANCE_PCTS,
  strategyExitModes: MODES, strategyIndicationTypes: INDICATIONS,
  strategyIndicationSources:[...PORTED_CATALOG,...RESEARCH_TACTIC_SOURCES].map(s=>s.id),
  strategyLowRangeSources:LOW_RANGE_IDS,
  strategySignalsSources:SIGNALS_CATALOG.map(s=>s.id),
  strategySignalPeriods:[10,14,20,40,60],strategyCoreSignalPeriods:CORE_SIGNAL_PERIODS,strategySignalTimeframes:SIGNAL_TIMEFRAMES,
}
export const FACTOR_FIELDS = [
  { key:"signalsMaxWindowDrawdownPct",label:"Signals gate return drawdown limit (pp; 0 = disabled)",min:0,max:50,step:.1 },
  { key:"microMinSlDistancePct", label:"Micro / Low-Range minimum SL (% of entry)",min:0,max:10,step:.01 },
  { key:"microMinTrailDistancePct", label:"Micro / Low-Range minimum trailing gap (% of entry)",min:0,max:10,step:.01 },
  { key:"microTrailRatio", label:"Micro / Low-Range trail width factor",min:.05,max:10,step:.05 },
  { key: "normalVolumeRatio", label: "Normal budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "axisVolumeRatio", label: "Axis budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "blockVolumeFactor", label: "Block budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "dcaVolumeRatio", label: "DCA budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "relateVolumeRatio", label: "Relate budget ratio", min: 0.001, max: 100, step: 0.001 },
  { key: "strategyTpFactor", label: "TP distance factor", min: 0.05, max: 10, step: 0.05 },
  { key: "strategySlFactor", label: "SL / TP ratio factor", min: 0.05, max: 10, step: 0.05 },
  { key: "strategyTrailRatio", label: "Trail / SL distance ratio", min: 0.05, max: 10, step: 0.05 },
  { key: "holdTimeFactor", label: "Maximum hold factor", min: 0.05, max: 10, step: 0.05 },
]
export const ALL_NUMERIC_FIELDS = [...AUTO_PF_FIELDS, ...NUMERIC_FIELDS, EXEC_PF_FIELD, ...COST_FIELDS, ...EXECUTION_FIELDS, ...COORDINATION_FIELDS, ...FACTOR_FIELDS]

const sourceKinds=new Map([...PORTED_CATALOG,...RESEARCH_TACTIC_SOURCES].map(s=>[s.id,s.kind]))
export function configurationCount(values: Record<string, unknown>) {
  const ranges = values.strategyEnabledRanges as string[]
  const types=values.strategyIndicationTypes as string[]
  // A draft selection can be empty while the operator is editing. The saved settings schema rejects it.
  const price = { enabled: values.strategyPriceDistancesEnabled === true,
    stops: (values.strategyStopDistancePcts ?? STOP_DISTANCE_PCTS) as number[],
    trails: (values.strategyTrailDistancePcts ?? TRAIL_DISTANCE_PCTS) as number[] }
  const variantCounts = new Map(ranges.map(range => [range, protectionVariants(range as StrategyRange,
    (values.strategyExitModes as ExitMode[]).filter(mode => mode === "fixed" || strategyProcessing(values, { range: range as StrategyRange }).trailing),
    values.strategySlRatios as number[], price, Number(values.microMinSlDistancePct ?? .1), Number(values.microMinTrailDistancePct ?? .05)).length]))
  let cells=0,lowRangeCells=0
  for(const step of values.strategyTpSteps as number[])for(const range of [RANGES[RANGE_BOUNDS.findIndex(bound=>step<=bound)],...(step<=8?["Low-Range"]:[])]){
    if(!ranges.includes(range))continue
    const count = variantCounts.get(range) ?? 0
    cells += count
    if (range === "Low-Range" && LOW_RANGE_STEPS.some(candidate => candidate === step)) lowRangeCells += count
  }
  const portedTypes=types.filter(t=>t==='Tactic'||t==='Inverse')
  const sourceIds=values.strategyIndicationSources as string[]
  const timeframes = values.strategySignalTimeframes as number[]
  const extra=portedTypes.reduce((n,t)=>n+sourceIds.filter(id=>sourceKinds.get(id)===t.toLowerCase())
    .reduce((sum,id)=>sum+timeframes.filter(tf=>t==='Inverse'?[1,5,15].includes(tf):supportsTacticTimeframe(id,tf)).length,0),0)
  const signals=types.includes('Signals')?1:0,signalSources=(values.strategySignalsSources??DEFAULT_SIGNALS_SOURCES) as string[]
  const hasLowRange = types.includes("Low-Range")
  const lowRangeSources = (values.strategyLowRangeSources ?? DEFAULT_LOW_RANGE_SOURCES) as string[]
  const lowRangeCount = hasLowRange
    ? lowRangeCells * lowRangeSources.length * timeframes.filter(tf => LOW_RANGE_TIMEFRAMES.some(minutes => tf === minutes)).length : 0
  const native = types.filter(type=>!["Tactic","Inverse","Signals","Low-Range"].includes(type)).reduce((count,type)=>
    count+indicationPeriods(type,values.strategySignalPeriods as number[],(values.strategyCoreSignalPeriods??[0]) as number[]).length,0)
  const count = lowRangeCount + cells * ((native+signals*signalSources.length)*timeframes.length+extra)
  return values.stageGateMode === "exec-branches" ? count : count * lastNVariantCount((values.strategyLastNGrid ?? {}) as LastNGrid)
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
      if (key === "strategyStageCoordinations") { output[key] = {}; continue }
      if (key === "strategyExecWindows" || key === "execMinPF" || key === "strategyCoreSignalPeriods" || EXEC_PROFILES.some(profile=>profile.setting===key)) { output[key] = structuredClone(DEFAULTS[key]); continue }
      if (Object.hasOwn(AUTO_PF_DEFAULTS,key)) {
        output[key] = key === "autoPfMode" && values.autoPfEnabled === true ? "tp-distance" : DEFAULTS[key]
        continue
      }
      throw new Error(`Configuration is missing ${key}.`)
    }
    const value = values[key]
    const arrayOptions = ARRAY_FIELDS[key]
    const enumOptions = ENUM_FIELDS[key]
    const field = ALL_NUMERIC_FIELDS.find(item => item.key === key)
    if(key==="stageBlocks"){
      if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["base","main","real"].includes(k)))throw new Error("Invalid stage blocks");
      for(const policy of Object.values(value))checkBlockPolicy(policy as BlockPolicy);output[key]=structuredClone(value);
    } else if (key === "strategyStageCoordinations") {
      output[key] = checkStageCoordinations(value)
    } else if (key === "strategyLastNGrid") {
      output[key] = structuredClone(checkLastNGrid(value))
    } else if (key === "strategyExecWindows") {
      output[key] = structuredClone(checkExecWindows(value))
    } else if (key === "relationalVolumeRatios") {
      output[key]=relationalVolumeSettings(value,true)
    } else if (key === "strategyProcessingByRange") {
      output[key] = validateProcessingByRange(value)
    } else if (arrayOptions) {
      if (!Array.isArray(value) || !value.length || value.some(item => !arrayOptions.includes(item)) || new Set(value).size !== value.length) throw new Error(`Choose valid, unique values for ${key}.`)
      output[key] = [...value]
    } else if (enumOptions) {
      if (typeof value !== "string" || !enumOptions.includes(value)) throw new Error(`Choose a valid value for ${key}.`)
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
    autoPfPolicy(output)
    if (output.axisPrevEnabled && Number(output.axisPrevious) + Number(output.axisLast) > 250) throw new Error("Axis previous and recent windows must total 250 samples or fewer.")
    const count = configurationCount(output)
    if (count === 0) throw new Error("Choose at least one active configuration across your ranges, exit modes, sources and timeframes.")
    const windows = output.strategyLastNGrid as LastNGrid
    const exec = output.stageGateMode === "exec-branches"
    if (exec && ["baseProfitFactor","mainProfitFactor","realProfitFactor"].some(key => Number(output[key]) < 1.01)) {
      throw new Error("Base, Main and Real minimum PF must be at least 1.01 in Exec progression.")
    }
    if ((output.strategyPriceDistancesEnabled || LAST_N_STAGES.some(stage => windows[stage]?.length)) && (output.stageGateMode === "parent-branches" ? count / lastNVariantCount(windows) : count) > EXPANDED_CATALOG_MAX) {
      throw new Error(`Expanded catalog exceeds ${EXPANDED_CATALOG_MAX} configurations. Select fewer distances, sources, timeframes or windows.`)
    }
  }
  for (const [label, minimum, window] of [
    ["Block Auto", output.blockAutoMinSamples, output.blockAutoLastN],
    ["DCA Auto", output.dcaAutoMinSamples, output.dcaAutoLastN],
    ["Relate", output.relateMinTrades, output.relateLastN],
  ]) {
    if (typeof minimum === "number" && typeof window === "number" && minimum > window) {
      throw new Error(`${label} minimum observations cannot exceed its recent observation window.`)
    }
  }
  return output
}

export function hydrate(settings: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(DEFAULTS)
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (settings[key] === undefined) continue
    if(key==="stageBlocks"){try{result[key]=validateConfiguration({stageBlocks:JSON.parse(settings[key])},{partial:true}).stageBlocks}catch{}} else if (key === "strategyStageCoordinations") {
      try { result[key] = checkStageCoordinations(JSON.parse(settings[key])) } catch { /* Keep legacy defaults. */ }
    } else if (key === "strategyLastNGrid") {
      try { result[key] = checkLastNGrid(JSON.parse(settings[key])) } catch { /* Preserve defaults on invalid legacy data. */ }
    } else if (key === "strategyExecWindows") {
      try { result[key] = checkExecWindows(JSON.parse(settings[key])) } catch { /* Preserve defaults on invalid data. */ }
    } else if (key === "relationalVolumeRatios") {
      try{result[key]=relationalVolumeSettings(JSON.parse(settings[key]),true)}catch{}
    } else if (key === "strategyProcessingByRange") {
      try { result[key] = validateProcessingByRange(JSON.parse(settings[key])) } catch { /* Preserve defaults on invalid legacy data. */ }
    } else if (Array.isArray(fallback)) {
      try { const parsed: unknown = JSON.parse(settings[key]); if (Array.isArray(parsed) && parsed.length) result[key] = parsed } catch { /* Keep a visible default for an invalid saved value. */ }
    } else if (typeof fallback === "boolean") result[key] = settings[key] === "true" || settings[key] === "1"
    else if (typeof fallback === "string") { if (ENUM_FIELDS[key]?.includes(settings[key])) result[key] = settings[key] }
    else { const number = Number(settings[key]); if (Number.isFinite(number)) result[key] = number }
  }
  if (settings.autoPfMode === undefined && (settings.autoPfEnabled === "true" || settings.autoPfEnabled === "1")) result.autoPfMode = "tp-distance"
  return result
}

/** The same editable schema is used by forms, JSON imports and server writes. */
export function flatEngineSettings(s:EngineSettings,control:{symbolCount:number;historyCandles:number}):Record<string,unknown>{
  const values:Record<string,unknown>={...structuredClone(DEFAULTS)}
  const blockAuto = s.coordinations.block.auto ?? DEFAULT_STEP_AUTO
  const dcaAuto = s.coordinations.dca.auto ?? DEFAULT_STEP_AUTO
  const relate = s.coordinations.relate ?? DEFAULT_RELATE
  for(const [key,value] of Object.entries(s.catalog))if(Object.hasOwn(DEFAULTS,key))values[key]=value
  values.autoPfEnabled = s.catalog.autoPfEnabled === true
  if (values.autoPfEnabled && s.catalog.autoPfMode === undefined) values.autoPfMode = "tp-distance"
  return {...values,stageBlocks:s.stageBlocks??{},liveEntryMode:s.liveEntryMode??'independent',stageGateMode:s.stageGateMode??'continuous-ancestors',symbolCount:control.symbolCount,historyCandles:control.historyCandles,volumeFactor:s.volumeFactor,baseNotional:s.baseNotional,maxOrderNotional:s.maxOrderNotional??0,
    stageWindowScope:s.stageWindowScope??"context",microStageWindowScope:s.microStageWindowScope??"inherit",
    normalVolumeRatio:s.volumeRatios?.normal??1,axisVolumeRatio:s.volumeRatios?.axis??1,blockVolumeFactor:s.volumeRatios?.block??1,dcaVolumeRatio:s.volumeRatios?.dca??1,relateVolumeRatio:s.volumeRatios?.relate??1,
    prevPosWindow:s.stageLastN.base,mainEvalPosCount:s.stageLastN.main,realEvalPosCount:s.stageLastN.real,
    baseProfitFactor:s.stageMinPF.base,mainProfitFactor:s.stageMinPF.main,realProfitFactor:s.stageMinPF.real,execMinPF:s.execMinPF??DEFAULT_EXEC_MIN_PF,
    variantBlockEnabled:s.coordinations.block.enabled,variantDcaEnabled:s.coordinations.dca.enabled,axisPrevEnabled:s.coordinations.axis.enabled,
    blockVolumeRatio:s.coordinations.block.ratio,axisPrevious:s.coordinations.axis.previous,axisLast:s.coordinations.axis.last,axisOutcome:s.coordinations.axis.outcome,axisReferenceStage:s.coordinations.axis.reference??'same-stage',
    blockBehavior:s.coordinations.block.behavior??"pyramid",blockSize:s.coordinations.block.size??3,blockPauseRounds:s.coordinations.block.pauseRounds??1,blockMaxMultiplier:s.coordinations.block.maxMultiplier??3,
    blockAutoEnabled:blockAuto.enabled,blockAutoLastN:blockAuto.lastN,blockAutoMinSamples:blockAuto.minSamples,blockAutoMinPF:blockAuto.minPF,
    blockSteps:s.coordinations.block.steps,blockMode:s.coordinations.block.mode,dcaSteps:s.coordinations.dca.steps,dcaDistancePct:s.coordinations.dca.distancePct,dcaMultiplier:s.coordinations.dca.multiplier,
    dcaAutoEnabled:dcaAuto.enabled,dcaAutoLastN:dcaAuto.lastN,dcaAutoMinSamples:dcaAuto.minSamples,dcaAutoMinPF:dcaAuto.minPF,
    relateEnabled:relate.enabled,relateSteps:relate.steps,relateRatio:relate.ratio,relateLastN:relate.lastN,relateMinTrades:relate.minTrades,
    relateMinPF:relate.minPF,relateMaxMultiplier:relate.maxMultiplier,relateMaxSlRatio:relate.maxSlRatio}
}

