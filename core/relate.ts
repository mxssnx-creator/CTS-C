import { stepVerdict } from "./step-evidence"
import { autoPfEvidence, autoPfMinimum } from "./auto-pf"
import type { RelateSettings, StrategyConfig } from "./types"
import { relateLossLevel, weightedRelateDecision, type RelateSource } from "../shared/cts-relate/policy"

export const DEFAULT_RELATE: RelateSettings = {
  enabled: false, steps: 12, ratio: .2, lastN: 250, minTrades: 60,
  minPF: 1.1, maxMultiplier: 2, maxSlRatio: .5,
}

/** The exact post-Base Set clears its own Auto PF before any relation can raise its size. */
export function relateAllocation(samples: readonly number[], config: StrategyConfig, policy: RelateSettings, timedCount = 0,
  levelOf: (source: RelateSource) => number | null = () => null): number {
  return relateDecision(samples, config, policy, timedCount, levelOf).multiplier
}

export function relateDecision(samples: readonly number[], config: StrategyConfig, policy: RelateSettings, timedCount = 0,
  levelOf: (source: RelateSource) => number | null = () => null): {multiplier: number; active: boolean} {
  if (!policy.enabled) return {multiplier: 1, active: true}
  if (config.exitMode === "trailing-only" || config.exitMode === "trailing-only-fixed" ||
    !(config.takeprofit > 0 && config.stoploss > 0 && config.stoploss <= config.takeprofit * policy.maxSlRatio + 1e-12))
    return {multiplier: 1, active: !policy.activeStep}
  const autoPf = autoPfMinimum(config.autoPfPolicy,autoPfEvidence(config.autoPfPolicy,samples,policy.lastN,timedCount))
  const verdict = stepVerdict(samples, 1, {
    enabled: true, lastN: policy.lastN, minSamples: policy.minTrades, minPF: Math.max(policy.minPF, config.autoPfFloor ?? 0, autoPf),
  })
  if (verdict.state !== "qualified") return {multiplier: 1, active: !policy.activeStep}
  return weightedRelateDecision(relateLossLevel(samples, policy), policy, policy.scope, policy.volumeFactors, levelOf)
}
