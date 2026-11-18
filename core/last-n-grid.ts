import type { Stage } from "./types"
import { EXPANDED_CATALOG_MAX } from "./protection-grid"

export const LAST_N_STAGES = ["base", "main", "real"] as const
export type EvaluationStage = Exclude<Stage, "live">
export type LastNGrid = Partial<Record<EvaluationStage, readonly number[]>>
export type ConfigLastN = Partial<Record<EvaluationStage, number>>

export function checkLastNGrid(input: unknown, max = 250): LastNGrid {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Last-N grid must be a stage map")
  for (const [stage, values] of Object.entries(input)) {
    if (!LAST_N_STAGES.includes(stage as EvaluationStage) || !Array.isArray(values) ||
        new Set(values).size !== values.length || values.some(n => !Number.isInteger(n) || n < 1 || n > max)) {
      throw new Error(`Invalid ${stage} Last-N grid. Use distinct sample counts between 1 and ${max}.`)
    }
  }
  return input as LastNGrid
}

export function lastNVariantCount(grid: LastNGrid): number {
  return LAST_N_STAGES.reduce((count, stage) => count * (grid[stage]?.length || 1), 1)
}

export function lastNVariants(grid: LastNGrid): (ConfigLastN | undefined)[] {
  if (lastNVariantCount(grid) > EXPANDED_CATALOG_MAX) throw new Error("Last-N grid is too large. Select fewer stage windows.")
  const sizes = (stage: EvaluationStage) => grid[stage]?.length ? grid[stage]! : [undefined]
  return sizes("base").flatMap(base => sizes("main").flatMap(main => sizes("real").map(real =>
    base === undefined && main === undefined && real === undefined ? undefined : { base, main, real })))
}
