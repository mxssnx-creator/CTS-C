import type { EngineSettings, LaneState } from './types'

type Policy = EngineSettings['coordinations']['block']
export function blockRoundBudget(lane: LaneState, policy: Policy): number {
  const state = lane.blockRound
  if (state?.pauseRemaining) return 0
  return Math.min(policy.maxMultiplier ?? 3, 1 + (state?.level ?? 0) * policy.ratio)
}

/** A completed block is evaluated once, using net PnL after costs. */
export function settleBlockRound(lane: LaneState, netPnl: number, policy: Policy): void {
  const state = lane.blockRound ??= {closed:0,sum:0,net:0,level:0,pauseRemaining:0,rounds:0}
  state.closed++; state.sum += netPnl; state.net += netPnl
  if (state.closed < (policy.size ?? 3)) return
  state.rounds++
  if (state.net > 0) {
    state.level = 0; state.net = 0; state.pauseRemaining = policy.pauseRounds ?? 1
  } else if (state.sum < 0) state.level = Math.min(policy.steps, state.level + 1)
  state.closed = 0; state.sum = 0
}

/** Pauses consume full blocks of subsequent eligible signals; no fictitious PnL. */
export function consumeBlockPause(lane: LaneState, policy: Policy): boolean {
  const state = lane.blockRound
  if (!state?.pauseRemaining) return false
  state.closed++
  if (state.closed >= (policy.size ?? 3)) { state.closed = 0; state.pauseRemaining-- }
  return true
}
