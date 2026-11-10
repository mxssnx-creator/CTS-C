export type ProfitFactorState = "empty" | "flat" | "no-losses" | "finite"

export function formatProfitFactor(value: number | null | undefined, state?: ProfitFactorState, places = 3): string {
  if (state === "empty") return "—"
  if (state === "no-losses") return "∞ · no losses"
  if (state === "flat") return `${(1).toFixed(places)} · flat`
  // Older snapshots use 999 as a no-loss sentinel. Only an explicit finite
  // state can establish that 999 is a measured ratio rather than that marker.
  if (state === undefined && value === 999) return "— · state unavailable"
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(places) : "—"
}

export function profitFactorRank(value: number | null, state?: ProfitFactorState): number {
  if (state === "empty") return -Infinity
  if (state === "no-losses") return Infinity
  if (state === "flat") return 1
  return value ?? -Infinity
}
