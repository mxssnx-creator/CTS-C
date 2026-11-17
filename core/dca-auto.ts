import { describeProfitFactor } from "./metrics"
import type { DcaAutoPolicy, DcaStepVerdict, LaneState, PaperPosition } from "./types"

export const DEFAULT_DCA_AUTO: DcaAutoPolicy = { enabled: false, lastN: 30, minSamples: 15, minPF: 1.1 }

export function validateDcaAuto(policy: DcaAutoPolicy): DcaAutoPolicy {
  if (
    !policy || typeof policy.enabled !== "boolean" ||
    !Number.isInteger(policy.lastN) || policy.lastN < 3 || policy.lastN > 100 ||
    !Number.isInteger(policy.minSamples) || policy.minSamples < 3 || policy.minSamples > policy.lastN ||
    !Number.isFinite(policy.minPF) || policy.minPF < 1.01 || policy.minPF > 10
  ) throw new Error("Invalid DCA Auto evaluation settings")
  return { enabled: policy.enabled, lastN: policy.lastN, minSamples: policy.minSamples, minPF: policy.minPF }
}

export function dcaStepVerdict(lane: LaneState, step: number, policy: DcaAutoPolicy): DcaStepVerdict {
  const returns = lane.dcaStepReturns?.[step - 1] ?? []
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

/** One adverse step per observed price, including when the corresponding add is held. */
export function observeDcaStep(position: PaperPosition, price: number, steps: number, distancePct: number): number {
  const prices = position.dcaProbePrices
  if (!prices || prices.length >= steps) return 0
  const reference = prices.at(-1) ?? position.fills[0].price
  const sign = position.direction === "long" ? 1 : -1
  const adverse = -sign * (price - reference) / reference * 100
  if (adverse < distancePct) return 0
  return prices.push(price)
}

export function settleDcaSteps(lane: LaneState, position: PaperPosition, exitPrice: number) {
  const policy = position.sizing?.dca.auto
  if (!policy?.enabled || !position.dcaProbePrices?.length) return
  const sign = position.direction === "long" ? 1 : -1
  const returns = lane.dcaStepReturns ??= []
  for (const [i, price] of position.dcaProbePrices.entries()) {
    const value = sign * (exitPrice - price) / price * 100 - position.costPct
    const step = returns[i] ??= []
    step.unshift(Number.isFinite(value) ? value : null)
    step.length = Math.min(step.length, policy.lastN)
  }
}
