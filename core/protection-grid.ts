import type { ExitMode, StrategyRange } from "./types"

export const STOP_DISTANCE_PCTS = Array.from({ length: 21 }, (_, i) => (i + 2) / 10)
export const TRAIL_DISTANCE_PCTS = Array.from({ length: 25 }, (_, i) => (i + 2) / 10)
export const EXPANDED_CATALOG_MAX = 100_000

export function priceProtection(settings: Record<string, unknown>) {
  const enabled = settings.strategyPriceDistancesEnabled
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Price-distance grid requires an enabled switch")
  const readDistances = (key: string, allowed: readonly number[]) => {
    const value = settings[key]
    const values: unknown = value === undefined ? allowed : typeof value === "string" ? JSON.parse(value) : value
    if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length ||
        values.some(pct => typeof pct !== "number" || !allowed.includes(pct))) {
      throw new Error(`Choose unique 0.1 percentage-point steps for ${key}.`)
    }
    return values as number[]
  }
  return {
    enabled: enabled === true,
    stops: readDistances("strategyStopDistancePcts", STOP_DISTANCE_PCTS),
    trails: readDistances("strategyTrailDistancePcts", TRAIL_DISTANCE_PCTS),
  }
}

export type ProtectionVariant = { exitMode: ExitMode; ratio: number; stopPct?: undefined; trailPct?: undefined }
  | { exitMode: ExitMode; ratio?: undefined; stopPct: number; trailPct: number }

export function protectionVariants(
  range: StrategyRange, modes: readonly ExitMode[], ratios: readonly number[],
  price: ReturnType<typeof priceProtection>, microMinSl: number, microMinTrail: number,
): ProtectionVariant[] {
  const micro = range === "Micro" || range === "Low-Range"
  if (!price.enabled) return ratios.filter(ratio => !micro || ratio <= 1.6)
    .flatMap(ratio => modes.map(exitMode => ({ exitMode, ratio })))

  const stops = micro ? price.stops.filter(stop => stop >= microMinSl) : price.stops
  const trails = micro ? price.trails.filter(trail => trail >= microMinTrail) : price.trails
  return stops.flatMap(stopPct => modes.flatMap(exitMode =>
    (exitMode === "fixed" ? [0] : trails).map(trailPct => ({ exitMode, stopPct, trailPct }))))
}
