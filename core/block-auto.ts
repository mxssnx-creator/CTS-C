import { recordStepReturn, stepVerdict } from "./step-evidence"
import type { EngineSettings, LaneState, PaperPosition, StepAutoPolicy } from "./types"

type BlockSettings = EngineSettings["coordinations"]["block"]

export function blockStepVerdict(lane: LaneState, step: number, policy: StepAutoPolicy) {
  return stepVerdict(lane.blockStepReturns?.[step - 1] ?? [], step, policy)
}

export function checkBlockPyramidAdd(lane: LaneState, position: PaperPosition, price: number, settings: BlockSettings): boolean {
  const probes = position.blockProbePrices
  const reference = probes ? probes.at(-1) ?? position.fills[0].price : position.lastAddPrice
  const sign = position.direction === "long" ? 1 : -1
  const favorableMove = sign * (price - reference) / reference * 100
  if (!(favorableMove >= position.takeProfitPct / (settings.steps + 1))) return false
  if (!settings.auto?.enabled) return true
  if (!probes || probes.length >= settings.steps) return false
  const step = probes.push(price)
  return step === position.addedSteps + 1 && blockStepVerdict(lane, step, settings.auto).state === "qualified"
}

export function settleBlockSteps(lane: LaneState, position: PaperPosition, exitPrice: number, netReturnPct: number): void {
  const policy = position.sizing?.block.auto
  if (!policy?.enabled) return
  const level = position.blockRoundLevel
  if (level !== undefined && level > 0) {
    // A held round raise observes the same unit return at its base size.
    recordStepReturn(lane.blockStepReturns ??= [], level, netReturnPct, policy.lastN)
  }
  if (!position.blockProbePrices?.length) return
  const sign = position.direction === "long" ? 1 : -1
  const returns = lane.blockStepReturns ??= []
  for (const [index, price] of position.blockProbePrices.entries()) {
    const value = sign * (exitPrice - price) / price * 100 - position.costPct
    recordStepReturn(returns, index + 1, value, policy.lastN)
  }
}
