import { stepVerdict } from "./step-evidence"
import { autoPfEvidence, autoPfMinimum } from "./auto-pf"
import type { RelateSettings, StrategyConfig } from "./types"
import { RELATE_SOURCES, relateLossLevel, relateMultiplier, weightedRelateDecision, type RelateSource } from "../shared/cts-relate/policy"
import { consecutiveLosses, DEFAULT_RELATE_RECOVERY_DRAWDOWN, DEFAULT_RELATE_RECOVERY_TRADES,
  recoveryQualified, type RelateTrial } from "../shared/cts-relate/recovery"

export type RelateTrialStamp = {step: number; size: number}
export type RelateRelationTrials = Partial<Record<RelateSource, RelateTrialStamp>>
export type RelateEvidence = {samples: readonly number[]; trials: readonly RelateTrial[]}

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

/** An unfunded trial still records which exact recovery step was proposed at entry. */
export function relateExecution(samples: readonly number[], config: StrategyConfig, policy: RelateSettings, timedCount: number,
  evidence: {trials: readonly RelateTrial[]; before: number; since: number; stageMinPF: number},
  evidenceOf: (source: RelateSource) => RelateEvidence | undefined):
    {multiplier: number; active: boolean; trial?: RelateTrialStamp; relationTrials?: RelateRelationTrials} {
  const held = {multiplier: 1, active: false}
  if (!policy.enabled || config.exitMode === "trailing-only" || config.exitMode === "trailing-only-fixed" ||
      !(config.takeprofit > 0 && config.stoploss > 0 && config.stoploss <= config.takeprofit * policy.maxSlRatio + 1e-12)) return held
  const step = consecutiveLosses(samples, Math.min(timedCount, policy.steps))
  if (!step && policy.scope !== "overall") return held
  const minTrades = policy.recoveryMinTrades ?? DEFAULT_RELATE_RECOVERY_TRADES
  const basicFloor = Math.max(evidence.stageMinPF, policy.minPF, config.autoPfFloor ?? 0)
  const maxDrawdown = policy.recoveryMaxDrawdownRatio ?? DEFAULT_RELATE_RECOVERY_DRAWDOWN
  const qualifies = (group: RelateEvidence, level: number, floor: number, since: number) =>
    level >= Math.max(1, policy.activeStep ?? 0) && group.trials.length >= minTrades &&
    relateLossLevel(group.samples, {...policy, minPF: floor}) === level &&
    recoveryQualified(group.trials, level, evidence.before, since, minTrades, floor, maxDrawdown)
  const relationTrials: RelateRelationTrials = {}
  const levels = new Map<RelateSource, number>()
  if (policy.scope === "overall") {
    const weight = RELATE_SOURCES.reduce((sum, source) => sum + (policy.volumeFactors?.[source] ?? 1), 0)
    for (const source of RELATE_SOURCES) {
      const factor = policy.volumeFactors?.[source] ?? 1
      if (source === "config" || factor === 0) continue
      const group = evidenceOf(source)
      if (!group) continue
      const level = consecutiveLosses(group.samples, policy.steps)
      if (!level) continue
      relationTrials[source] = {step: level, size: 1 + (relateMultiplier(level, policy) - 1) * factor / weight}
      if (qualifies(group, level, basicFloor, 0)) levels.set(source, level)
    }
  }
  const proposed = weightedRelateDecision(step, policy, policy.scope, policy.volumeFactors, source => levels.get(source) ?? null)
  const receipts = {
    ...(step > 0 && {trial: {step, size: Math.max(proposed.multiplier, relateMultiplier(step, policy))}}),
    ...(Object.keys(relationTrials).length > 0 && {relationTrials}),
  }
  if (evidence.trials.length < minTrades || samples.length < policy.minTrades) return {...held, ...receipts}
  const floor = Math.max(basicFloor, autoPfMinimum(config.autoPfPolicy,
    autoPfEvidence(config.autoPfPolicy, samples, policy.lastN, timedCount)))
  return {...(qualifies({samples, trials: evidence.trials}, step, floor, evidence.since) ? proposed : held), ...receipts}
}
