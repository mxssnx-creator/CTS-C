import type { StrategyConfig } from "./types"

export const PROCESSING_RANGES = ["Micro", "Minimal", "Short", "Normal", "Long", "Wide"] as const
export type ProcessingSwitches = { normal?: boolean; trailing?: boolean }
export type ProcessingByRange = Partial<Record<typeof PROCESSING_RANGES[number], ProcessingSwitches>>

export function validateProcessingByRange(input: unknown): ProcessingByRange {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Strategy range processing must be an object")
  for (const [range, switches] of Object.entries(input)) {
    if (!(PROCESSING_RANGES as readonly string[]).includes(range) || !switches || typeof switches !== "object" || Array.isArray(switches)) throw new Error("Invalid strategy processing range")
    for (const [key, value] of Object.entries(switches)) if (!["normal", "trailing"].includes(key) || typeof value !== "boolean") throw new Error("Strategy processing switches must be boolean")
  }
  return structuredClone(input) as ProcessingByRange
}

/** Normal evidence remains available to every independently configured adjustment lane. */
export function strategyProcessing(settings: Record<string, unknown>, config: Pick<StrategyConfig, "range">) {
  const ranges = settings.strategyProcessingByRange as ProcessingByRange | undefined
  const range = config.range ? ranges?.[config.range] : undefined
  return {
    normal: settings.strategyNormalEnabled !== false && range?.normal !== false,
    trailing: settings.strategyTrailingEnabled !== false && range?.trailing !== false,
  }
}
