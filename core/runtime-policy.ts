import type { ExecutionIntent } from "./types"

export interface IntentPolicyContext {
  activePositionIds: ReadonlySet<string>
  /** Engine intent IDs found by exact lookup in the durable venue journal. */
  submittedIntentIds: ReadonlySet<string>
  now: number
  maxEntryAgeMs?: number
  maxAddAgeMs?: number
  limit?: number
}
export interface IntentPlan {
  ready: ExecutionIntent[]
  rejected: { id: string; error: string }[]
}
/** Cancel obsolete signals before they can reach the exchange. A durable
 * submission is never discarded: reconciliation owns all uncertain outcomes.
 * Close urgency applies between positions, never ahead of its own entry/add.
 */
export function planExecutionIntents(intents: readonly ExecutionIntent[], context: IntentPolicyContext): IntentPlan {
  const entryAge = context.maxEntryAgeMs ?? 30_000
  const addAge = context.maxAddAgeMs ?? 30_000
  const limit = context.limit ?? 10
  if (!Number.isFinite(context.now) || !Number.isFinite(entryAge) || entryAge <= 0 || !Number.isFinite(addAge) || addAge <= 0 || !Number.isInteger(limit) || limit < 1) throw new Error("Invalid execution scheduling policy")
  const rejected: IntentPlan["rejected"] = []
  const groups = new Map<string, ExecutionIntent[]>()
  const seen = new Set<string>()
  for (const intent of intents) {
    if (seen.has(intent.id) || intent.status !== "pending") continue
    seen.add(intent.id)
    if (!context.submittedIntentIds.has(intent.id) && intent.kind !== "close") {
      let error: string | undefined
      if (!context.activePositionIds.has(intent.positionId)) error = "Signal expired: its paper position is already closed; no exchange order submitted"
      else if (!Number.isFinite(intent.timestamp) || intent.timestamp > context.now + 5_000) error = "Signal timestamp is invalid or in the future; no exchange order submitted"
      else if (context.now - intent.timestamp > (intent.kind === "entry" ? entryAge : addAge)) error = "Signal expired before submission; no exchange order submitted"
      if (error) { rejected.push({ id: intent.id, error }); continue }
    }
    const key = JSON.stringify([intent.connectionId, intent.positionId])
    const group = groups.get(key) || []
    group.push(intent)
    groups.set(key, group)
  }
  const kindOrder = { entry: 0, add: 1, close: 2 }
  const ordered = [...groups.entries()].map(([key, items]) => ({
    key,
    urgent: items.some((intent) => intent.kind === "close"),
    items: items.sort((a, b) => a.timestamp - b.timestamp || kindOrder[a.kind] - kindOrder[b.kind] || a.id.localeCompare(b.id)),
  })).sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.items[0].timestamp - b.items[0].timestamp || a.key.localeCompare(b.key))
  return { ready: ordered.flatMap((group) => group.items).slice(0, limit), rejected }
}
