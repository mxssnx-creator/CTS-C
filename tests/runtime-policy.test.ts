import assert from "node:assert/strict"
import { test } from "node:test"
import { planExecutionIntents } from "../core/runtime-policy"
import type { ExecutionIntent } from "../core/types"
const now = 1_000_000
function intent(id: string, kind: ExecutionIntent["kind"], positionId = "position-a", timestamp = now - 1000): ExecutionIntent {
  return { id, kind, positionId, timestamp, connectionId: "bingx-x02", laneId: "lane-a", configId: "config-a", symbol: "BTC-USDT", direction: "long", requestedQuantity: 1, price: 100, notional: 100, stopLossPct: 1, takeProfitPct: 2, exitMode: "fixed", source: "real-qualified", status: "pending" }
}
const context = { now, activePositionIds: new Set(["position-a", "position-b"]), submittedIntentIds: new Set<string>() }

test("closed before submission cancels the entry instead of opening an orphan after its close", () => {
  const entry = intent("entry", "entry"), close = intent("close", "close", "position-a", now)
  const plan = planExecutionIntents([close, entry], { ...context, activePositionIds: new Set() })
  assert.deepEqual(plan.rejected.map(item => item.id), ["entry"])
  assert.deepEqual(plan.ready.map(item => item.id), ["close"])
})
test("a submitted unknown entry remains ahead of its own close for reconciliation", () => {
  const entry = intent("entry", "entry", "position-a", 1), close = intent("close", "close")
  const plan = planExecutionIntents([close, entry], { ...context, activePositionIds: new Set(), submittedIntentIds: new Set(["entry"]) })
  assert.equal(plan.rejected.length, 0)
  assert.deepEqual(plan.ready.map(item => item.id), ["entry", "close"])
})
test("stale or future entries and additions are rejected but closes are never age-discarded", () => {
  const plan = planExecutionIntents([intent("old", "entry", "position-a", now - 30_001), intent("future", "add", "position-a", now + 5_001), intent("close", "close", "position-b", 1)], context)
  assert.deepEqual(plan.rejected.map(item => item.id), ["old", "future"])
  assert.deepEqual(plan.ready.map(item => item.id), ["close"])
})
test("close priority between positions preserves FIFO within each position and batch limit", () => {
  const plan = planExecutionIntents([intent("b-entry", "entry", "position-b"), intent("a-close", "close", "position-a", now), intent("a-entry", "entry", "position-a", now - 2000), intent("a-add", "add", "position-a", now - 1000)], { ...context, limit: 3 })
  assert.deepEqual(plan.ready.map(item => item.id), ["a-entry", "a-add", "a-close"])
})
test("duplicate and previously settled engine intents are not requeued", () => {
  const row = intent("entry", "entry")
  const plan = planExecutionIntents([row, row, { ...intent("settled", "entry"), status: "acknowledged" }], context)
  assert.deepEqual(plan.ready.map(item => item.id), ["entry"])
})
