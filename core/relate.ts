import { stepVerdict, validateStepAuto } from "./step-evidence"
import { autoPfEvidence, autoPfMinimum } from "./auto-pf"
import type { RelateAutoSettings, RelateSettings, StrategyConfig } from "./types"

export const DEFAULT_RELATE: RelateSettings = {
  enabled: false, steps: 12, ratio: .2, lastN: 250, minTrades: 60,
  minPF: 1.1, maxMultiplier: 2, maxSlRatio: .5,
}
/**
 * Judge the newest 30 returns once 8 exist, and only with a positive mean 1.64 standard errors above zero (95%, one-sided).
 * On 108 held-out symbol-days this cut activations on noise about fivefold against 6 returns and 1.0, with no slower
 * activation when a real edge exists.
 */
export const DEFAULT_RELATE_AUTO: RelateAutoSettings = { enabled: false, lastN: 30, minSamples: 8, minPF: 1.1, confidence: 1.64, inherit: true }

export function validateRelateAuto(policy: RelateAutoSettings): RelateAutoSettings {
  const base = validateStepAuto(policy, "Relate")
  if (!Number.isFinite(policy.confidence) || policy.confidence < 0 || policy.confidence > 3) throw new Error("Invalid Relate Auto evaluation settings")
  if (typeof policy.inherit !== "boolean") throw new Error("Invalid Relate Auto evaluation settings")
  return { ...base, confidence: policy.confidence, inherit: policy.inherit }
}

/**
 * Trailing-only exits have no fixed target. Manual sizing also needs the stop inside `maxSlRatio` of the target. Auto
 * sizing applies to every relation, including the default 0.6, 1.0 and 1.4 stop ratios that the manual cap (at most
 * 0.5) can never admit: its PF and confidence gate already prices a large stop into the realized returns.
 */
function eligible(config: StrategyConfig, policy: RelateSettings): boolean {
  if (config.exitMode === "trailing-only" || config.exitMode === "trailing-only-fixed" || !(config.takeprofit > 0 && config.stoploss > 0)) return false
  return Boolean(policy.auto?.enabled) || config.stoploss <= config.takeprofit * policy.maxSlRatio + 1e-12
}

/**
 * Winning-run sizing: volume rises by `ratio` for every consecutive win (capped), for every relation that qualifies.
 * Returns are net per-position percentages, newest first. A loss resets the run, so exposure only grows on proof.
 *
 * Manual mode judges the Set's own 60+ returns. Auto mode needs only a handful: the newest `lastN` returns (own,
 * then older non-overlapping returns of the same trade stream in ancestor Sets) must have PF above the larger of
 * its own floor, the config floor and the Auto PF floor, and a positive mean that clears `confidence` standard
 * errors, so a few lucky trades cannot raise volume.
 */
export function relateAllocation(samples: readonly number[], config: StrategyConfig, policy: RelateSettings, timedCount = 0, inherited?: readonly number[]): number {
  if (!policy.enabled || !eligible(config, policy)) return 1
  if (policy.auto?.enabled) return autoAllocation(samples, inherited, config, policy, policy.auto, timedCount)
  const autoPf = autoPfMinimum(config.autoPfPolicy,autoPfEvidence(config.autoPfPolicy,samples,policy.lastN,timedCount))
  const verdict = stepVerdict(samples, 1, {
    enabled: true, lastN: policy.lastN, minSamples: policy.minTrades, minPF: Math.max(policy.minPF, config.autoPfFloor ?? 0, autoPf),
  })
  if (verdict.state !== "qualified") return 1
  let wins = 0
  while (wins < policy.steps && samples[wins] > 0) wins++
  return Math.min(policy.maxMultiplier, 1 + wins * policy.ratio)
}

function autoAllocation(own: readonly number[], inherited: readonly number[] | undefined, config: StrategyConfig, policy: RelateSettings, auto: RelateAutoSettings, timedCount: number): number {
  const older = auto.inherit && inherited?.length ? inherited : undefined
  const tape = older ? [...own, ...older] : own
  const window = Math.min(tape.length, auto.lastN)
  if (window < auto.minSamples) return 1
  let profit = 0, loss = 0, sum = 0
  for (let i = 0; i < window; i++) {
    const value = tape[i]
    if (!Number.isFinite(value)) return 1
    profit += Math.max(0, value); loss += Math.max(0, -value); sum += value
  }
  if (!(profit > 0) || !(sum > 0) || !Number.isFinite(profit + loss)) return 1
  // Dated evidence only: older untimed returns never calibrate a floor.
  const timed = timedCount < own.length ? timedCount : timedCount + (older?.length ?? 0)
  const floor = Math.max(auto.minPF, config.autoPfFloor ?? 0, autoPfMinimum(config.autoPfPolicy, autoPfEvidence(config.autoPfPolicy, tape, window, timed)))
  if (loss > 0 && profit / loss < floor) return 1
  if (auto.confidence > 0 && window > 1) {
    const mean = sum / window
    let squares = 0
    for (let i = 0; i < window; i++) squares += (tape[i] - mean) ** 2
    const standardError = Math.sqrt(squares / (window - 1) / window)
    if (standardError > 0 && mean / standardError < auto.confidence) return 1
  }
  let wins = 0
  while (wins < policy.steps && wins < window && tape[wins] > 0) wins++
  return Math.min(policy.maxMultiplier, 1 + wins * policy.ratio)
}
