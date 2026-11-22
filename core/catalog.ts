import { PORTED_CATALOG, DEFAULT_TACTIC_SOURCES, DEFAULT_INVERSE_SOURCES } from "../shared/cts-indications/catalog.ts"
import { DEFAULT_LOW_RANGE_SOURCES, LOW_RANGE_IDS, LOW_RANGE_STEPS, LOW_RANGE_TIMEFRAMES } from "../shared/cts-indications/low-range-catalog.ts"
import {checkedSignalsSources} from '../shared/cts-indications/signals-catalog'
import { strategyProcessing, validateProcessingByRange } from "./strategy-processing"
import { relationalVolumeSettings } from "../shared/cts-volume/ratios"
import { DEFAULT_EXIT_MODES, EXIT_MODES, type EngineSettings, type StrategyConfig } from "./types"
import { createHash } from "node:crypto"
import { resolveTradingCostPct } from "./metrics"
import { CORE_INDICATIONS, CORE_SIGNAL_PERIODS, INDICATIONS,TECHNICAL_INDICATIONS, indicationPeriods } from "./indications"
import { EXPANDED_CATALOG_MAX, priceProtection, protectionVariants } from "./protection-grid"
import { checkLastNGrid, lastNVariants } from "./last-n-grid"
import { AUTO_PF_DEFAULTS, autoPfPolicy } from "./auto-pf"
import { RESEARCH_TACTIC_SOURCES, SIGNAL_TIMEFRAMES, supportsTacticTimeframe } from "../shared/cts-indications/research-sources"
import preset from "../research-data/exec-dca-trend-preset.json"
import { EXEC_PROFILES, execProfileEnabled } from "./exec-profile"
import { INVERSE_CONTINUATION_SOURCES } from "../shared/cts-indications/inverse-sources"

export const STRATEGY_RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide", "Low-Range"] as const
export const STRATEGY_TYPES = INDICATIONS
export { EXIT_MODES, type ExitMode } from "./types"
export type StrategyRange = typeof STRATEGY_RANGES[number]
const bounds = [5, 8, 12, 18, 24, 30]
const holdMinutes = [15, 30, 60, 240, 720, 1440]
const distanceKey = (pct:number) => {
  const tenths = Math.round(pct*10)
  return Math.abs(pct*10-tenths)<1e-9 ? String(tenths) : `${Math.round(pct*100)}bps`
}
export function strategyRangeForStep(step: number): StrategyRange {
  if (!Number.isInteger(step) || step < 2 || step > 30) throw new Error("TP step must be an integer from 2 to 30")
  return STRATEGY_RANGES[bounds.findIndex(bound => step <= bound)]
}
function values(settings: Record<string, unknown>, name: string, defaults: readonly unknown[]): unknown[] {
  const raw = settings[name]
  if (raw === undefined || raw === null || raw === "") return [...defaults]
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`)
  return [...new Set(parsed)]
}
function selected<T extends string>(settings: Record<string, unknown>, name: string, allowed: readonly T[], defaults: readonly T[] = allowed): T[] {
  const parsed = values(settings, name, defaults)
  if (parsed.some(value => !allowed.includes(value as T))) throw new Error(`Unsupported ${name}`)
  return parsed as T[]
}
/** Complete, deterministic Cartesian catalog. No head truncation can silently omit a tactic or range. */
export function generateStrategyCatalog(connectionId: string, settings: Record<string, unknown> = {}, now = new Date().toISOString()): StrategyConfig[] {
  if(settings.relationalVolumeRatios!==undefined)relationalVolumeSettings(settings.relationalVolumeRatios,true)
  for (const key of ["strategyNormalEnabled", "strategyTrailingEnabled"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") throw new Error(`${key} must be boolean`)
  if (settings.strategyProcessingByRange !== undefined) validateProcessingByRange(settings.strategyProcessingByRange)
  const ranges = selected(settings, "strategyEnabledRanges", STRATEGY_RANGES,STRATEGY_RANGES.filter(r=>r!=="Low-Range"))
  const types = selected(settings, "strategyIndicationTypes", STRATEGY_TYPES, CORE_INDICATIONS)
  const modes = selected(settings, "strategyExitModes", EXIT_MODES, DEFAULT_EXIT_MODES)
  const periods=values(settings,'strategySignalPeriods',[20]).map(Number),timeframes=values(settings,'strategySignalTimeframes',[1]).map(Number)
  if(!periods.length||periods.some(p=>![10,14,20,40,60].includes(p))||!timeframes.length||timeframes.some(t=>!SIGNAL_TIMEFRAMES.some(tf=>tf===t)))throw new Error('Unsupported signal periods or timeframes')
  const commonPeriods=values(settings,"strategyCoreSignalPeriods",[0]).map(Number)
  if (!commonPeriods.length||commonPeriods.some(p=>!CORE_SIGNAL_PERIODS.some(period=>period===p))) throw new Error("Unsupported common indication periods")
  const steps = [...new Set(values(settings, "strategyTpSteps", Array.from({length: 29}, (_, i) => i + 2)).map(Number))]
  if (steps.some(step => !Number.isInteger(step) || step < 2 || step > 30)) throw new Error("strategyTpSteps must contain integers 2..30")
  const ratios = [...new Set(values(settings, "strategySlRatios", Array.from({length: 15}, (_, i) => (i + 2) / 10)).map(Number))]
  if (ratios.some(r => !Number.isFinite(r) || r < .2 || r > 2.2 || Math.abs(r * 10 - Math.round(r * 10)) > 1e-9)) throw new Error("strategySlRatios must be 0.2..2.2 in steps of 0.1")
  const price = priceProtection(settings)
  const windowVariants = lastNVariants(checkLastNGrid(settings.strategyLastNGrid))
  const expanded = price.enabled || windowVariants[0] !== undefined
  for (const key of ["makerFeePct", "takerFeePct", "slippagePctOfFees"]) {
    if (settings[key] !== undefined && (!Number.isFinite(Number(settings[key])) || Number(settings[key]) < 0 || Number(settings[key]) > 100)) throw new Error(`Invalid ${key}`)
  }
  const cost = resolveTradingCostPct({ makerFeePct: Number(settings.makerFeePct), takerFeePct: Number(settings.takerFeePct), slippagePctOfFees: Number(settings.slippagePctOfFees) })
  if (cost <= 0) throw new Error("Cost-step strategy requires a positive round-trip cost")
  const factor=(key:string,fallback=1)=>{const value=Number(settings[key]??fallback);if(!Number.isFinite(value)||value<.05||value>10)throw new Error(`Invalid ${key}`);return value}
  const tpFactor=factor('strategyTpFactor'),slFactor=factor('strategySlFactor'),trailRatio=factor('strategyTrailRatio'),microTrailRatio=factor('microTrailRatio',.5),holdFactor=factor('holdTimeFactor')
  const microDistance=(key:string,fallback:number)=>{const value=Number(settings[key]??fallback);if(!Number.isFinite(value)||value<0||value>10)throw new Error(`Invalid ${key}`);return value}
  const microMinSl=microDistance('microMinSlDistancePct',.1)/100,microMinTrail=microDistance('microMinTrailDistancePct',.05)
  const selectedSources=values(settings,'strategyIndicationSources',[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES]).map(String)
  const sourceKinds=new Map<string,string>([...PORTED_CATALOG,...RESEARCH_TACTIC_SOURCES,...INVERSE_CONTINUATION_SOURCES].map(s=>[s.id,s.kind]))
  if(selectedSources.some(id=>!sourceKinds.has(id)))throw new Error('Unknown Tactic / Inverse source')
  const signalsSources=checkedSignalsSources(settings.strategySignalsSources)
  const lowRangeSources = selected(settings, "strategyLowRangeSources", LOW_RANGE_IDS, DEFAULT_LOW_RANGE_SOURCES)
  const maxWindowDrawdownPct=Number(settings.signalsMaxWindowDrawdownPct??3)
  if(!Number.isFinite(maxWindowDrawdownPct)||maxWindowDrawdownPct<0||maxWindowDrawdownPct>50)throw Error('Invalid Signals return drawdown limit')
  const sourceList=(type:string)=>type==='Signals'?signalsSources:type==='Low-Range'?lowRangeSources:(type==='Tactic'||type==='Inverse')?selectedSources.filter(id=>sourceKinds.get(id)===type.toLowerCase()):[undefined]
  for(const type of types)if(!sourceList(type).length)throw new Error(`Choose at least one ${type} source`)
  const periodsByType = new Map(types.map(type=>[type,indicationPeriods(type,periods,commonPeriods)]))
  const adaptivePf = autoPfPolicy(settings)
  const distancePf = settings.autoPfEnabled === true && !adaptivePf
  const autoPfRatio=Number(settings.autoPfRatio??AUTO_PF_DEFAULTS.autoPfRatio),autoPfMax=Number(settings.autoPfMax??AUTO_PF_DEFAULTS.autoPfMax)
  const configs: StrategyConfig[] = []
  const variants = new Map(ranges.map(range => [range, protectionVariants(range,
    modes.filter(mode => mode === "fixed" || strategyProcessing(settings, { range }).trailing),
    ratios, price, microDistance('microMinSlDistancePct', .1), microMinTrail)]))
  for (const step of steps) for(const range of [strategyRangeForStep(step),...(step<=8?["Low-Range" as const]:[])]) {
    if (!ranges.includes(range)) continue
    const applicableTypes = range === "Low-Range" && LOW_RANGE_STEPS.some(candidate => candidate === step)
      ? types : types.filter(type => type !== "Low-Range")
    for (const type of applicableTypes) for (const indicationSourceId of sourceList(type)) for (const geometry of variants.get(range)!) {
     const { exitMode, stopPct, trailPct } = geometry
     const technical=(TECHNICAL_INDICATIONS as readonly string[]).includes(type),ported=!!indicationSourceId
     for(const period of periodsByType.get(type)!)for(const timeframe of timeframes){
      if(type==='Inverse'&&![1,5,15].includes(timeframe))continue
      if(type==='Tactic'&&!supportsTacticTimeframe(indicationSourceId!,timeframe))continue
      if (type === "Low-Range" && !LOW_RANGE_TIMEFRAMES.some(minutes => minutes === timeframe)) continue
      const takeprofit = cost / 100 * step*tpFactor
      const micro=range==="Micro"||range==="Low-Range"
      const stoploss = stopPct === undefined ? Math.max(takeprofit * geometry.ratio * slFactor, micro ? microMinSl : 0) : stopPct / 100
      const ratio = geometry.ratio ?? stoploss / takeprofit
      const trailDistancePct = trailPct ?? Math.max(stoploss*100*trailRatio*(micro?microTrailRatio:1),micro?microMinTrail:0)
      if(takeprofit>=1||stoploss>=1||trailDistancePct>=100)throw new Error('TP, SL and trailing distances must be below 100%')
      const lookback = period
      const maxHoldMinutes = (range==="Low-Range"?15:holdMinutes[STRATEGY_RANGES.indexOf(range)])*holdFactor
      const autoPfFloor=distancePf?Math.max(1.01,Math.min(autoPfMax,1+Math.floor(takeprofit*1000+1e-9)/10*autoPfRatio)):undefined
      const economics = createHash("sha256").update(JSON.stringify([type, takeprofit, stoploss, cost, maxHoldMinutes, lookback, exitMode,trailDistancePct, "ratcheted-trailing-v2",...(indicationSourceId?[indicationSourceId]:[]),...(timeframe!==1||technical||ported?[timeframe,'closed-ohlcv-v1']:[]),autoPfFloor,...(adaptivePf?["set-auto-pf-v1",adaptivePf]:[]),...(type==='Signals'?['signals-risk-v1',maxWindowDrawdownPct]:[])])).digest("hex").slice(0, 20)
      const distanceId = stopPct === undefined ? `sl${Math.round(ratio * 10)}` : `sp${distanceKey(stopPct)}_gp${distanceKey(trailPct!)}`
      const id = `v4_${type}_${range}_tp${step}_${distanceId}_${exitMode}_${economics}`
      if (expanded && configs.length + windowVariants.length > EXPANDED_CATALOG_MAX) {
        throw new Error(`Expanded catalog exceeds ${EXPANDED_CATALOG_MAX} configurations. Select fewer distances, sources, timeframes or windows.`)
      }
      for (const stageLastN of windowVariants) configs.push({
        id: stageLastN ? `${id}_n${stageLastN.base ?? 0}-${stageLastN.main ?? 0}-${stageLastN.real ?? 0}` : id,
        ...(stageLastN ? { stageLastN } : {}), connectionId, createdAt: now, enabled: true, catalogVersion: 4,
        type, ...(autoPfFloor!==undefined?{autoPfFloor}:{}), ...(adaptivePf?{autoPfPolicy:adaptivePf}:{}), ...(type==='Signals'&&maxWindowDrawdownPct>0?{maxWindowDrawdownPct}:{}), ...(indicationSourceId?{indicationSourceId}:{}), range, tpStep: step, slRatio: ratio, exitMode,
        // Indicator lookback is separate from the cost-distance step.
        position_cost_step: lookback,
        takeprofit, stoploss, trailing: exitMode !== "fixed", roundTripCostPct: cost,
        maxHoldMinutes,trailDistancePct,signalTimeframeMinutes:timeframe,
      })
     }
    }
  }
  return configs
}

/** Reference profiles use independent geometries with the connection's fee and slippage inputs. */
export function generateEngineCatalog(settings: EngineSettings, fees?: NonNullable<EngineSettings["symbolFees"]>[string]): StrategyConfig[] {
  const catalog: Record<string,unknown> = {...settings.catalog,...fees}
  if (settings.stageGateMode === "parent-branches" || settings.stageGateMode === "exec-branches") catalog.strategyLastNGrid = undefined
  const createdAt = "1970-01-01T00:00:00.000Z"
  const configs = generateStrategyCatalog(settings.connectionId,catalog,createdAt)
  for (const profile of EXEC_PROFILES) if (execProfileEnabled(settings,profile)) {
    for (const variant of profile.catalogs) {
      const geometries = generateStrategyCatalog(settings.connectionId,{
        ...preset,...variant,makerFeePct:catalog.makerFeePct,takerFeePct:catalog.takerFeePct,slippagePctOfFees:catalog.slippagePctOfFees,
      },createdAt)
      for (const geometry of geometries) configs.push({...geometry,id:`${geometry.id}.${profile.id}`,execProfile:profile.id})
    }
  }
  return configs
}
