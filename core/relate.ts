import { stepVerdict } from "./step-evidence"
import type { RelateSettings, StrategyConfig } from "./types"

export const DEFAULT_RELATE: RelateSettings = {
  enabled: false, steps: 12, ratio: .2, lastN: 250, minTrades: 60,
  minPF: 1.1, maxMultiplier: 2, maxSlRatio: .5,
}

/** CTS-G's winning-run add policy applied to the exact prior Set tape. */
export function relateAllocation(samples: readonly number[], config: StrategyConfig, policy: RelateSettings): number {
  if (!policy.enabled || config.exitMode === "trailing-only" || config.exitMode === "trailing-only-fixed" ||
    !(config.takeprofit > 0 && config.stoploss > 0 && config.stoploss <= config.takeprofit * policy.maxSlRatio + 1e-12)) return 1
  const verdict = stepVerdict(samples, 1, {
    enabled: true, lastN: policy.lastN, minSamples: policy.minTrades, minPF: Math.max(policy.minPF, config.autoPfFloor ?? 0),
  })
  if (verdict.state !== "qualified") return 1
  let wins = 0
  while (wins < policy.steps && samples[wins] > 0) wins++
  return Math.min(policy.maxMultiplier, 1 + wins * policy.ratio)
}
