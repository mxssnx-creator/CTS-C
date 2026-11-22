export const AUTO_PF_DEFAULTS = {
  autoPfEnabled: true,
  autoPfMode: "set-history",
  autoPfFallback: 1.10,
  autoPfMinSamples: 16,
  autoPfHistory: 40,
  autoPfAdjustment: .75,
  autoPfRatio: .2,
  autoPfMax: 2,
} as const

export interface AutoPfPolicy {
  readonly fallback: number
  readonly minSamples: number
  readonly history: number
  readonly adjustment: number
  readonly cap: number
}

export type AutoPfEvidence =
  | { mode: "fallback"; samples: number }
  | { mode: "set-history"; samples: number; profit: number; loss: number }

export function autoPfPolicy(settings: Record<string, unknown>): AutoPfPolicy | undefined {
  const { autoPfEnabled, autoPfMode = "tp-distance" } = settings
  if (autoPfEnabled !== undefined && typeof autoPfEnabled !== "boolean") throw new Error("Invalid Auto PF enabled")
  if (autoPfMode !== "tp-distance" && autoPfMode !== "set-history") throw new Error("Invalid Auto PF mode")
  const number = (key: keyof typeof AUTO_PF_DEFAULTS, min: number, max: number, integer = false) => {
    const value = Number(settings[key] ?? AUTO_PF_DEFAULTS[key])
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`Invalid Auto PF setting: ${key}`)
    return value
  }
  const cap = number("autoPfMax", 1.01, 10)
  number("autoPfRatio", 0, 2)
  if (autoPfMode === "tp-distance") return
  const fallback = number("autoPfFallback", 1.01, cap)
  const history = number("autoPfHistory", 3, 250, true)
  const minSamples = number("autoPfMinSamples", 3, history, true)
  const adjustment = number("autoPfAdjustment", 0, 4)
  if (autoPfEnabled) return Object.freeze({ fallback, minSamples, history, adjustment, cap })
}

/** Index zero is newest. Calibration only sees dated closes older than the decision window. */
export function autoPfEvidence(policy: AutoPfPolicy | undefined, returns: readonly number[], skip: number, timedCount: number): AutoPfEvidence | undefined {
  if (!policy) return
  const end = Math.min(skip + policy.history, timedCount, returns.length)
  let samples = 0, profit = 0, loss = 0
  for (let i = skip; i < end; i++) {
    const value = returns[i]
    if (!Number.isFinite(value)) break
    samples++
    profit += Math.max(0, value)
    loss += Math.max(0, -value)
    if (!Number.isFinite(profit) || !Number.isFinite(loss)) return { mode: "fallback", samples: 0 }
  }
  return samples >= policy.minSamples ? { mode: "set-history", samples, profit, loss } : { mode: "fallback", samples }
}

/** The fallback is a floor. Weak older returns increase the burden of current evidence. */
export function autoPfMinimum(policy: AutoPfPolicy | undefined, evidence: AutoPfEvidence | undefined): number {
  if (!policy) return 0
  if (evidence?.mode !== "set-history") return policy.fallback
  const historicPf = evidence.loss > 0 ? evidence.profit / evidence.loss : evidence.profit > 0 ? policy.fallback : 1
  return Math.min(policy.cap, policy.fallback + policy.adjustment * Math.max(0, policy.fallback - historicPf))
}

export function validAutoPfEvidence(policy: AutoPfPolicy | undefined, evidence: AutoPfEvidence | undefined): boolean {
  if (!policy) return evidence === undefined
  if (!evidence || !Number.isSafeInteger(evidence.samples) || evidence.samples < 0 || evidence.samples > policy.history) return false
  if (evidence.mode === "fallback") return evidence.samples < policy.minSamples
  return evidence.mode === "set-history" && evidence.samples >= policy.minSamples &&
    Number.isFinite(evidence.profit) && evidence.profit >= 0 && Number.isFinite(evidence.loss) && evidence.loss >= 0
}
