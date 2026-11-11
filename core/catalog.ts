import { PORTED_CATALOG, DEFAULT_TACTIC_SOURCES, DEFAULT_INVERSE_SOURCES } from "../shared/cts-indications/catalog.ts"
import { strategyProcessing, validateProcessingByRange } from "./strategy-processing"
import { relationalVolumeSettings } from "../shared/cts-volume/ratios"
import type { StrategyConfig } from "./types"
import { createHash } from "node:crypto"
import { resolveTradingCostPct } from "./metrics"
import { CORE_INDICATIONS, INDICATIONS,TECHNICAL_INDICATIONS } from "./indications"

export const STRATEGY_RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide"] as const
export const STRATEGY_TYPES = INDICATIONS
export const EXIT_MODES = ["fixed", "trailing", "trailing-only"] as const
export type StrategyRange = typeof STRATEGY_RANGES[number]
export type ExitMode = typeof EXIT_MODES[number]
const bounds = [5, 8, 12, 18, 24, 30]
const holdMinutes = [15, 30, 60, 240, 720, 1440]
export function strategyRangeForStep(step: number): StrategyRange {
  if (!Number.isInteger(step) || step < 3 || step > 30) throw new Error("TP step must be an integer from 3 to 30")
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
  for (const key of ["strategyNormalEnabled", "strategyTrailingEnabled"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") throw new Error(`${key} must be boolean`)
  if (settings.strategyProcessingByRange !== undefined) validateProcessingByRange(settings.strategyProcessingByRange)
  if (settings.relationalVolumeRatios !== undefined) relationalVolumeSettings(settings.relationalVolumeRatios, true)
  const ranges = selected(settings, "strategyEnabledRanges", STRATEGY_RANGES)
  const types = selected(settings, "strategyIndicationTypes", STRATEGY_TYPES, CORE_INDICATIONS)
  const modes = selected(settings, "strategyExitModes", EXIT_MODES)
  const periods=values(settings,'strategySignalPeriods',[20]).map(Number),timeframes=values(settings,'strategySignalTimeframes',[1]).map(Number)
  if(!periods.length||periods.some(p=>![10,14,20,40,60].includes(p))||!timeframes.length||timeframes.some(t=>![1,5,15,30].includes(t)))throw new Error('Unsupported signal periods or timeframes')
  const steps = [...new Set(values(settings, "strategyTpSteps", Array.from({length: 28}, (_, i) => i + 3)).map(Number))]
  if (steps.some(step => !Number.isInteger(step) || step < 3 || step > 30)) throw new Error("strategyTpSteps must contain integers 3..30")
  const ratios = [...new Set(values(settings, "strategySlRatios", Array.from({length: 11}, (_, i) => (i + 1) / 5)).map(Number))]
  if (ratios.some(r => !Number.isFinite(r) || r < .2 || r > 2.2 || Math.abs(r * 5 - Math.round(r * 5)) > 1e-9)) throw new Error("strategySlRatios must be 0.2..2.2 in steps of 0.2")
  for (const key of ["makerFeePct", "takerFeePct", "slippagePctOfFees"]) {
    if (settings[key] !== undefined && (!Number.isFinite(Number(settings[key])) || Number(settings[key]) < 0 || Number(settings[key]) > 100)) throw new Error(`Invalid ${key}`)
  }
  const cost = resolveTradingCostPct({ makerFeePct: Number(settings.makerFeePct), takerFeePct: Number(settings.takerFeePct), slippagePctOfFees: Number(settings.slippagePctOfFees) })
  if (cost <= 0) throw new Error("Cost-step strategy requires a positive round-trip cost")
  const factor=(key:string)=>{const value=Number(settings[key]??1);if(!Number.isFinite(value)||value<.05||value>10)throw new Error(`Invalid ${key}`);return value}
  const tpFactor=factor('strategyTpFactor'),slFactor=factor('strategySlFactor'),trailRatio=factor('strategyTrailRatio'),holdFactor=factor('holdTimeFactor')
  const selectedSources=values(settings,'strategyIndicationSources',[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES]).map(String)
  const sourceKinds=new Map<string,string>(PORTED_CATALOG.map(s=>[s.id,s.kind]))
  if(selectedSources.some(id=>!sourceKinds.has(id)))throw new Error('Unknown Tactic / Inverse source')
  const sourceList=(type:string)=>(type==='Tactic'||type==='Inverse')?selectedSources.filter(id=>sourceKinds.get(id)===type.toLowerCase()):[undefined]
  for(const type of types)if(!sourceList(type).length)throw new Error(`Choose at least one ${type} source`)
  const configs: StrategyConfig[] = []
  for (const step of steps) {
    const range = strategyRangeForStep(step)
    if (!ranges.includes(range)) continue
    for (const type of types) for (const indicationSourceId of sourceList(type)) for (const ratio of ratios) for (const exitMode of modes) {
     if (exitMode !== "fixed" && !strategyProcessing(settings, {range}).trailing) continue
     const technical=(TECHNICAL_INDICATIONS as readonly string[]).includes(type),ported=!!indicationSourceId
     for(const period of technical?periods:[type==='RSI_Band'?14:20])for(const timeframe of technical||ported?timeframes:[1]){
      if(type==='Inverse'&&timeframe===30)continue
      const takeprofit = cost / 100 * step*tpFactor
      const stoploss = takeprofit * ratio*slFactor
      const trailDistancePct=stoploss*100*trailRatio
      if(takeprofit>=1||stoploss>=1||trailDistancePct>=100)throw new Error('TP, SL and trailing distances must be below 100%')
      const lookback = period
      const maxHoldMinutes = holdMinutes[STRATEGY_RANGES.indexOf(range)]*holdFactor
      const economics = createHash("sha256").update(JSON.stringify([type, takeprofit, stoploss, cost, maxHoldMinutes, lookback, exitMode,trailDistancePct, "ratcheted-trailing-v2",...(indicationSourceId?[indicationSourceId]:[]),...(technical||ported?[timeframe,'closed-ohlcv-v1']:[])])).digest("hex").slice(0, 20)
      const id = `v4_${type}_${range}_tp${step}_sl${Math.round(ratio * 5)}_${exitMode}_${economics}`
      configs.push({ id, connectionId, createdAt: now, enabled: true, catalogVersion: 4,
        type, ...(indicationSourceId?{indicationSourceId}:{}), range, tpStep: step, slRatio: ratio, exitMode,
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
