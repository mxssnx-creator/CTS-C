import { STOP_BANDS, fixedStopsAt, maxStopRatio, stopSelections, type StopBand } from "../shared/cts-protection/fixed-stop-bands.ts"
export { STOP_BANDS }
import type { ExitMode, StrategyRange } from "./types"

export const STOP_DISTANCE_PCTS = Array.from({ length: 21 }, (_, i) => (i + 2) / 10)
export const TRAIL_DISTANCE_PCTS = Array.from({ length: 25 }, (_, i) => (i + 2) / 10)
export const SELECTABLE_STOP_DISTANCE_PCTS = [.1,.15,...STOP_DISTANCE_PCTS]
export const SELECTABLE_TRAIL_DISTANCE_PCTS = [.05,.1,.15,...TRAIL_DISTANCE_PCTS]
export const EXPANDED_CATALOG_MAX = 100_000

export function priceProtection(settings: Record<string, unknown>) {
  const enabled = settings.strategyPriceDistancesEnabled
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Price-distance grid requires an enabled switch")
  const readDistances = (key: string, defaults: readonly number[], allowed: readonly number[], allowEmpty = false) => {
    const value = settings[key]
    const values: unknown = value === undefined ? defaults : typeof value === "string" ? JSON.parse(value) : value
    if (!Array.isArray(values) || (!allowEmpty && !values.length) || new Set(values).size !== values.length ||
        values.some(pct => typeof pct !== "number" || !allowed.includes(pct))) {
      throw new Error(`Choose unique 0.1 percentage-point steps or listed thin distances for ${key}.`)
    }
    return values as number[]
  }
  return {
    enabled: enabled === true,
    maxStopLossRatio: maxStopRatio(settings.maxStopLossRatio),
    fixedStops: settings.strategyShortStopPcts !== undefined || settings.strategyLongStopPcts !== undefined
      ? stopSelections({short: readDistances("strategyShortStopPcts", STOP_BANDS.short.stops, STOP_BANDS.short.stops, true),
                        long: readDistances("strategyLongStopPcts", STOP_BANDS.long.stops, STOP_BANDS.long.stops, true)}) : undefined,
    stops: readDistances("strategyStopDistancePcts",STOP_DISTANCE_PCTS,SELECTABLE_STOP_DISTANCE_PCTS),
    trails: readDistances("strategyTrailDistancePcts",TRAIL_DISTANCE_PCTS,SELECTABLE_TRAIL_DISTANCE_PCTS),
  }
}

export type ProtectionVariant = { exitMode: ExitMode; band?: undefined; ratio: number; stopPct?: undefined; trailPct?: undefined }
  | { exitMode: ExitMode; band?: StopBand; ratio?: undefined; stopPct: number; trailPct?: number }

export function protectionVariants(
  range: StrategyRange, modes: readonly ExitMode[], ratios: readonly number[],
  price: ReturnType<typeof priceProtection>, microMinSl: number, microMinTrail: number, tpPct?: number,
): ProtectionVariant[] {
  const micro = range === "Micro" || range === "Low-Range"
  if (price.fixedStops && tpPct !== undefined) {
    const choices = fixedStopsAt(tpPct, price.fixedStops, price.maxStopLossRatio).filter(row => !micro || row.stopPct >= microMinSl)
    return choices.flatMap(({band, stopPct}) => modes.flatMap(exitMode => {
      const trails = exitMode === "fixed" ? [0] : price.enabled
        ? price.trails.filter(t => !micro || t >= microMinTrail) : [undefined]
      return trails.map(trailPct => ({exitMode, band, stopPct, trailPct}))
    }))
  }
  if (!price.enabled) return ratios.filter(ratio => !micro || ratio <= 1.6)
    .flatMap(ratio => modes.map(exitMode => ({ exitMode, ratio })))

  const stops = micro ? price.stops.filter(stop => stop >= microMinSl) : price.stops
  const trails = micro ? price.trails.filter(trail => trail >= microMinTrail) : price.trails
  return stops.flatMap(stopPct => modes.flatMap(exitMode =>
    (exitMode === "fixed" ? [0] : trails).map(trailPct => ({ exitMode, stopPct, trailPct }))))
}
