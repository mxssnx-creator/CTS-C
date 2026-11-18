import { DEFAULT_STEP_AUTO, recordStepReturn, stepVerdict, validateStepAuto } from "./step-evidence"
import type { DcaAutoPolicy, StepVerdict, LaneState, PaperPosition } from "./types"

export const DEFAULT_DCA_AUTO = DEFAULT_STEP_AUTO

export function validateDcaAuto(policy: DcaAutoPolicy): DcaAutoPolicy {
  return validateStepAuto(policy, "DCA")
}

export function dcaStepVerdict(lane: LaneState, step: number, policy: DcaAutoPolicy): StepVerdict {
  return stepVerdict(lane.dcaStepReturns?.[step - 1] ?? [], step, policy)
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
    recordStepReturn(returns, i + 1, value, policy.lastN)
  }
}
