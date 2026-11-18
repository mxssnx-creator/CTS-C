import { describeProfitFactor } from "./metrics"
import type { StepAutoPolicy, StepVerdict } from "./types"

export const DEFAULT_STEP_AUTO: StepAutoPolicy = { enabled: false, lastN: 30, minSamples: 15, minPF: 1.1 }

export function validateStepAuto(policy: StepAutoPolicy, name: string): StepAutoPolicy {
  if (
    !policy || typeof policy.enabled !== "boolean" ||
    !Number.isInteger(policy.lastN) || policy.lastN < 3 || policy.lastN > 100 ||
    !Number.isInteger(policy.minSamples) || policy.minSamples < 3 || policy.minSamples > policy.lastN ||
    !Number.isFinite(policy.minPF) || policy.minPF < 1.01 || policy.minPF > 10
  ) throw new Error(`Invalid ${name} Auto evaluation settings`)
  return { enabled: policy.enabled, lastN: policy.lastN, minSamples: policy.minSamples, minPF: policy.minPF }
}

export function stepVerdict(returns: readonly (number | null)[], step: number, policy: StepAutoPolicy): StepVerdict {
  const count = Math.min(returns.length, policy.lastN)
  const result = { step, samples: count, required: policy.minSamples }
  let gains = 0, losses = 0
  for (let i = 0; i < count; i++) {
    const value = returns[i]
    if (value === null || !Number.isFinite(value)) return { ...result, profitFactor: null, state: "unknown" }
    if (value > 0) gains += value
    else losses -= value
  }
  if (!Number.isFinite(gains + losses)) return { ...result, profitFactor: null, state: "unknown" }
  const { profitFactor } = describeProfitFactor(gains, losses, count)
  if (count < policy.minSamples) return { ...result, profitFactor: count ? profitFactor : null, state: "warming" }
  return { ...result, profitFactor, state: profitFactor >= policy.minPF ? "qualified" : "held" }
}

export function recordStepReturn(returns: Array<Array<number | null>>, step: number, value: number, limit: number): void {
  const history = returns[step - 1] ??= []
  history.unshift(Number.isFinite(value) ? value : null)
  history.length = Math.min(history.length, limit)
}
