import type { BlockPolicy, Polarity } from "../shared/cts-lastn/blocks.ts"
import { EXPANDED_CATALOG_MAX } from "./protection-grid"

export const LAST_N_STAGES = ["base", "main", "real"] as const
export const EXEC_EVALUATION_STAGES = [...LAST_N_STAGES, "exec"] as const
export type LegacyEvaluationStage = typeof LAST_N_STAGES[number]
export type EvaluationStage = typeof EXEC_EVALUATION_STAGES[number]
export type LastNGrid = Partial<Record<LegacyEvaluationStage, readonly number[]>>
export type ConfigLastN = Partial<Record<LegacyEvaluationStage, number>>

export const EXEC_LONG_COUNTS = [10, 20, 30, 40, 50] as const
export const EXEC_SHORT_COUNTS = [4, 8, 12, 16] as const
export const EXEC_LAST_COUNTS = [1, 2, 3, 4, 5] as const
export const EXEC_LONG_MODES = ["none", "inherit"] as const
export const EXEC_OUTCOMES = ["positive", "negative"] as const
export const POSITIVE_EXEC_OUTCOME = ["positive"] as const
export const DEFAULT_EXEC_MIN_PF = 1.1
type ShortLast = { short: readonly number[]; last: readonly number[]; shortOutcomes?: readonly Polarity[]; lastOutcomes?: readonly Polarity[] }
export type ExecWindows = { base: ShortLast & { long: readonly number[] } } &
  Record<Exclude<EvaluationStage, "base">, ShortLast & { long: readonly typeof EXEC_LONG_MODES[number][] }>
const shortLast = { short: EXEC_SHORT_COUNTS, last: EXEC_LAST_COUNTS }
const inherited = { ...shortLast, long: EXEC_LONG_MODES }
export const DEFAULT_EXEC_WINDOWS: ExecWindows = { base: { ...shortLast, long: EXEC_LONG_COUNTS }, main: inherited, real: inherited, exec: inherited }

export function checkExecWindows(raw: unknown, maxSamples = Infinity): ExecWindows {
  function record(value: unknown): Record<string, unknown> {
    if (value === undefined) return {}
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Exec windows must be a stage map")
    return value as Record<string, unknown>
  }
  function choices<T>(value: unknown, options: readonly T[]): readonly T[] {
    if (value === undefined) return options
    if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(v => !options.includes(v))) {
      throw new Error("Select valid, distinct Exec window choices in every block")
    }
    return options.filter(v => value.includes(v))
  }
  const input = record(raw)
  if (Object.keys(input).some(stage => !EXEC_EVALUATION_STAGES.includes(stage as EvaluationStage))) throw new Error("Invalid Exec window stage")
  const result = {} as ExecWindows
  for (const stage of EXEC_EVALUATION_STAGES) {
    const fields = record(input[stage])
    if (Object.keys(fields).some(name => !["long","short","last","shortOutcomes","lastOutcomes"].includes(name))) throw new Error("Invalid Exec window block")
    const short = choices(fields.short, EXEC_SHORT_COUNTS), last = choices(fields.last, EXEC_LAST_COUNTS)
    const windows: ShortLast = { short,last,
      ...(fields.shortOutcomes!==undefined&&{shortOutcomes:choices(fields.shortOutcomes,EXEC_OUTCOMES)}),
      ...(fields.lastOutcomes!==undefined&&{lastOutcomes:choices(fields.lastOutcomes,EXEC_OUTCOMES)}),
    }
    if (!short.some(n=>execShortOutcomes(windows,n).length)) throw new Error(`Exec ${stage} needs a compatible Short size and outcome`)
    if (stage === "base") result.base = { ...windows, long: choices(fields.long, EXEC_LONG_COUNTS) }
    else result[stage] = { ...windows, long: choices(fields.long, EXEC_LONG_MODES) }
    const baseLong = stage === "base" || result[stage].long.includes("inherit") ? Math.max(...result.base.long) : 0
    if (baseLong + Math.max(...short) + Math.max(...last) > maxSamples) throw new Error(`Exec ${stage} windows exceed retained samples`)
  }
  return result
}

export function execPathCount(windows: ExecWindows): number {
  return EXEC_EVALUATION_STAGES.reduce((count, stage) => {
    const w = windows[stage]
    return count * w.long.length * w.short.reduce((sum,n)=>sum+execShortOutcomes(w,n).length,0) * w.last.length * (w.lastOutcomes?.length ?? 1)
  }, 1)
}

export function execShortOutcomes(windows: ShortLast, short: number): readonly Polarity[] {
  const outcomes = windows.shortOutcomes ?? POSITIVE_EXEC_OUTCOME
  return short <= 12 ? outcomes : outcomes.filter(outcome=>outcome==="positive")
}

export function execBlockPolicy(long: number, short: number, last: number, shortPolarity:Polarity="positive",minimalPolarity:Polarity="positive"): BlockPolicy {
  return { long, short, minimal: last, shortPolarity, minimalPolarity, lastRequiresPF: true }
}

export function checkLastNGrid(input: unknown, max = 250): LastNGrid {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Last-N grid must be a stage map")
  for (const [stage, values] of Object.entries(input)) {
    if (!LAST_N_STAGES.includes(stage as LegacyEvaluationStage) || !Array.isArray(values) ||
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
  const sizes = (stage: LegacyEvaluationStage) => grid[stage]?.length ? grid[stage]! : [undefined]
  return sizes("base").flatMap(base => sizes("main").flatMap(main => sizes("real").map(real =>
    base === undefined && main === undefined && real === undefined ? undefined : { base, main, real })))
}
