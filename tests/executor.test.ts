import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DemoExecutor, type ExecutorVenue, type ExecutionUpdate } from "../core/executor"
import { StateStore } from "../core/store"
import { stableClientOrderId, type OrderInput, type OrderOutcome, type VenueFill, type VenueOrder } from "../core/bingx"
import type { ExecutionIntent } from "../core/types"

const intent = (overrides: Partial<ExecutionIntent> = {}): ExecutionIntent => ({ id: "entry-1", connectionId: "x02", laneId: "lane-1", configId: "micro-1", symbol: "BTC-USDT", direction: "long",
  kind: "entry", positionId: "position-1", requestedQuantity: 2, timestamp: Date.now(), price: 100, notional: 200, takeProfitPct: 2, stopLossPct: 1, exitMode: "fixed", source: "real-qualified", status: "pending", ...overrides })
const status = (results: ExecutionUpdate[], id: string) => results.find((row) => row.id === id)?.status
function makeOrder(input: OrderInput, overrides: Partial<VenueOrder> = {}): VenueOrder {
  const conditional = input.type !== "MARKET" && input.type !== "LIMIT"
  return { orderId: `100${BigInt(`0x${input.clientOrderId.slice(5, 21)}`)}`, clientOrderId: input.clientOrderId, symbol: input.symbol,
    side: input.side, positionSide: input.positionSide, type: input.type, status: conditional ? "NEW" : "FILLED", quantity: Number(input.quantity), filledQuantity: conditional ? 0 : Number(input.quantity), averagePrice: conditional ? 0 : 100,
    price: 0, stopPrice: Number(input.stopPrice || 0), updateTime: Date.now(), ...overrides }
}
class Venue implements ExecutorVenue {
  configured = true
  submitted: OrderInput[] = []
  canceled: string[] = []
  orders = new Map<string, VenueOrder>()
  ledger = new Map<string, VenueFill[]>()
  submit?: (input: OrderInput) => Promise<OrderOutcome>
  conditionalSubmit?: (input: OrderInput) => Promise<OrderOutcome>
  fillOverride?: (order: VenueOrder) => VenueFill[]
  reads = { openOrders: 0, orderById: 0 }
  markets() { return this.submitted.filter((row) => row.type === "MARKET") }
  conditionals() { return this.submitted.filter((row) => row.type === "STOP_MARKET" || row.type === "TAKE_PROFIT_MARKET") }
  async positionMode() { return "hedge" as const }
  async contracts() { return [{ symbol: "BTC-USDT", quantityPrecision: 3, pricePrecision: 2, minQuantity: 0.001, minNotional: 1, maxLongLeverage: 100, maxShortLeverage: 100, status: "1" }] }
  async positions() { return [{ positionId: "venue-1", symbol: "BTC-USDT", direction: "LONG" as const, quantity: 1000, entryPrice: 100, markPrice: 100, unrealizedPnl: 0, leverage: 1 }] }
  async openOrders(): Promise<VenueOrder[]> {
    this.reads.openOrders++
    return structuredClone([...this.orders.values()].filter((order) => !["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)))
  }
  async submitOrder(input: OrderInput, beforeWrite?: () => void): Promise<OrderOutcome> {
    beforeWrite?.()
    this.submitted.push(input)
    const hook = input.type === "MARKET" ? this.submit : this.conditionalSubmit
    const outcome: OrderOutcome = hook ? await hook(input) : { status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input), recovered: false }
    if (outcome.status === "accepted") this.orders.set(input.clientOrderId, outcome.order)
    return structuredClone(outcome)
  }
  async reconcileOrder(_symbol: string, id: string): Promise<OrderOutcome> {
    const order = this.orders.get(id)
    return order ? { status: "accepted", clientOrderId: id, order: structuredClone(order), recovered: true } : { status: "unknown", clientOrderId: id, reason: "not yet confirmed" }
  }
  async orderById(_symbol: string, id: string): Promise<VenueOrder> {
    this.reads.orderById++
    const order = [...this.orders.values()].find((row) => row.orderId === id)
    if (!order) throw new Error("unavailable")
    return structuredClone(order)
  }
  async cancelOwnedOrder(_symbol: string, clientId: string, venueId?: string, beforeWrite?: () => void): Promise<OrderOutcome> {
    const order = this.orders.get(clientId)
    assert.ok(order, "cancel must target a known local order")
    assert.equal(venueId, order.orderId)
    beforeWrite?.()
    this.canceled.push(order.orderId)
    if (!["FILLED", "CANCELED"].includes(order.status)) order.status = "CANCELED"
    return { status: "accepted", clientOrderId: clientId, order: structuredClone(order), recovered: false }
  }
  async fills(orderId: string): Promise<VenueFill[]> {
    const order = [...this.orders.values()].find((row) => row.orderId === orderId)
    assert.ok(order, "fill query must target an accepted owned order")
    if (this.fillOverride) return this.fillOverride(order)
    const existing = this.ledger.get(orderId) || []
    const quantity = order.filledQuantity - existing.reduce((sum, fill) => sum + fill.quantity, 0)
    if (quantity > 1e-10) {
      const notional = order.filledQuantity * order.averagePrice - existing.reduce((sum, fill) => sum + fill.price * fill.quantity, 0)
      const closing = order.positionSide === "LONG" ? order.side === "SELL" : order.side === "BUY"
      const realizedPnl = closing ? (notional - quantity * 100) * (order.positionSide === "LONG" ? 1 : -1) : 0
      existing.push({ tradeId: `${orderId}${existing.length + 1}`, orderId, symbol: order.symbol, side: order.side, price: notional / quantity, quantity, realizedPnl, fee: -notional * 0.001, timestamp: Date.now() })
      this.ledger.set(orderId, existing)
    }
    return structuredClone(existing)
  }
}

test("actual fills create owned lots and native brackets exactly once", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  assert.equal(status(await executor.process([intent()]), "entry-1"), "acknowledged")
  await executor.process([intent()])
  assert.equal(venue.markets().length, 1)
  assert.equal(executor.lots()[0].quantity, 2)
  assert.equal(venue.markets()[0].stopLoss, undefined)
  assert.equal(venue.conditionals().find((row) => row.type === "STOP_MARKET")!.stopPrice, 99)
  assert.equal(venue.conditionals().find((row) => row.type === "TAKE_PROFIT_MARKET")!.stopPrice, 102)
  assert.equal(venue.conditionals().length, 2)
  assert.equal(executor.lots()[0].protection, "active")
  assert.equal(executor.summary().fees, 0.2)
})

test("partial fills use cumulative actual size and reconcile fees without duplicates", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input, { status: "PARTIALLY_FILLED", filledQuantity: 0.5, averagePrice: 100 }), recovered: false })
  assert.equal(status(await executor.process([intent()]), "entry-1"), "unknown")
  assert.equal(executor.lots()[0].quantity, 0.5)
  assert.equal(executor.summary().fees, 0.05)
  const existing = venue.orders.get(stableClientOrderId("x02", "entry-1"))!
  existing.status = "FILLED"; existing.filledQuantity = 2; existing.averagePrice = 101
  await executor.process([])
  assert.equal(executor.lots()[0].quantity, 2)
  assert.equal(executor.lots()[0].averageEntry, 101)
  assert.equal(executor.summary().fees, 0.202)
  await executor.process([])
  assert.equal(executor.lots()[0].quantity, 2)
  assert.equal(executor.summary().fees, 0.202)
  assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM execution_fill_ledger").get() as { n: number }).n, 2)
})

test("unknown outcomes survive restart and are queried without another market POST", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctsc-executor-")); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, "state.sqlite")
  const firstStore = new StateStore(filename), venue = new Venue()
  venue.submit = async (input) => ({ status: "unknown", clientOrderId: input.clientOrderId, reason: "response lost" })
  assert.equal(status(await new DemoExecutor(firstStore, venue).process([intent()]), "entry-1"), "unknown")
  firstStore.close()
  const restored = new StateStore(filename); t.after(() => restored.close())
  const executor = new DemoExecutor(restored, venue)
  await executor.process([intent()])
  assert.equal(venue.markets().length, 1)
  const id = stableClientOrderId("x02", "entry-1")
  venue.orders.set(id, makeOrder(venue.markets()[0]))
  await executor.process([intent()])
  assert.equal(venue.markets().length, 1)
  assert.equal(executor.lots()[0].quantity, 2)
})

test("SQLite intent is committed and visible before POST", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctsc-prewrite-")); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, "state.sqlite"), store = new StateStore(filename); t.after(() => store.close())
  const venue = new Venue()
  venue.submit = async (input) => {
    const freshReader = new StateStore(filename)
    assert.equal(freshReader.intent(input.clientOrderId)?.status, "reserved")
    freshReader.close()
    return { status: "rejected", clientOrderId: input.clientOrderId, reason: "test rejection" }
  }
  const executor = new DemoExecutor(store, venue)
  assert.equal(status(await executor.process([intent()]), "entry-1"), "rejected")
  assert.equal(executor.lots().length, 0)
})

test("manual close cancels only its own brackets and uses the actual lot quantity", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  await executor.process([intent()])
  const wrong = intent({ id: "wrong-close", kind: "close", laneId: "another-lane", requestedQuantity: 999 })
  assert.equal(status(await executor.process([wrong]), wrong.id), "rejected")
  assert.equal(venue.markets().length, 1)
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input, { averagePrice: 110 }), recovered: false })
  assert.equal(status(await executor.process([intent({ id: "close-1", kind: "close", requestedQuantity: 999 })]), "close-1"), "acknowledged")
  assert.equal(Number(venue.markets()[1].quantity), 2)
  assert.equal(venue.markets()[1].side, "SELL")
  assert.equal(venue.canceled.length, 2)
  assert.equal(executor.lots()[0].quantity, 0)
  assert.equal(executor.lots()[0].realizedGrossPnl, 20)
  assert.ok(Math.abs(executor.lots()[0].fees! - 0.42) < 1e-10)
  assert.ok(Math.abs(executor.lots()[0].realizedNetPnl! - 19.58) < 1e-10)
  assert.equal(executor.lots()[0].exchangeRealizedPnl, 20)
})

test("concurrent process calls issue one market write for one candidate", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  await Promise.all([executor.process([intent()]), executor.process([intent()])])
  assert.equal(venue.markets().length, 1)
})

test("unexplained venue reduction defers closes and new entries", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  await executor.process([intent()])
  venue.positions = async () => []
  assert.equal(status(await executor.process([intent({ id: "close-1", kind: "close" })]), "close-1"), "unknown")
  assert.equal(status(await executor.process([intent({ id: "entry-2", positionId: "position-2", laneId: "lane-2" })]), "entry-2"), "unknown")
  assert.equal(venue.markets().length, 1)
})

test("all unresolved intents remain visible beyond the former 1000-row window", (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  for (let index = 0; index < 1001; index++) store.claimIntent(`intent-${index}`, {})
  assert.equal(store.unresolvedIntents().length, 1001)
  assert.equal(store.intent("intent-0")?.status, "reserved")
})

test("native protective fill closes only its owned lane and cancels its sibling", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  await executor.process([intent(), intent({ id: "entry-2", positionId: "position-2", laneId: "lane-2" })])
  const firstStop = venue.orders.get(venue.conditionals()[0].clientOrderId)!
  const firstTakeProfit = venue.orders.get(venue.conditionals()[1].clientOrderId)!
  firstStop.status = "FILLED"; firstStop.filledQuantity = 2; firstStop.averagePrice = 99
  await executor.process([])
  const first = executor.lots().find((lot) => lot.laneId === "lane-1")!, second = executor.lots().find((lot) => lot.laneId === "lane-2")!
  assert.equal(first.quantity, 0)
  assert.equal(first.realizedGrossPnl, -2)
  assert.equal(first.protection, "closed")
  assert.equal(second.quantity, 2)
  assert.equal(second.protection, "active")
  assert.deepEqual(venue.canceled, [firstTakeProfit.orderId])
  assert.equal(venue.markets().length, 2)
})

test("terminal partial close remains pending until exact residual is filled", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  await executor.process([intent()])
  let closes = 0
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId,
    order: makeOrder(input, ++closes === 1 ? { status: "CANCELED", filledQuantity: 0.5, averagePrice: 110 } : { status: "FILLED", averagePrice: 111 }), recovered: false })
  const close = intent({ id: "close-1", kind: "close" })
  assert.equal(status(await executor.process([close]), close.id), "unknown")
  assert.equal(executor.lots()[0].quantity, 1.5)
  assert.equal(status(await executor.process([close]), close.id), "acknowledged")
  assert.equal(executor.lots()[0].quantity, 0)
  assert.equal(Number(venue.markets()[2].quantity), 1.5)
  assert.equal(venue.markets()[2].side, "SELL")
  assert.notEqual(venue.markets()[2].clientOrderId, venue.markets()[1].clientOrderId)
  await executor.process([close])
  assert.equal(venue.markets().length, 3)
})

test("signed rebates and repeated fill responses do not double-charge fees", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  venue.fillOverride = (order) => [{ tradeId: `${order.orderId}1`, orderId: order.orderId, symbol: order.symbol, side: order.side, price: 100, quantity: 2, realizedPnl: 0, fee: 0.04, timestamp: Date.now() }]
  await executor.process([intent()]); await executor.process([]); await executor.process([])
  assert.equal(executor.summary().fees, -0.04)
  assert.equal(executor.summary().realizedNetPnl, 0.04)
  assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM execution_fill_ledger").get() as { n: number }).n, 1)
})

test("stale entry and add intents never send new orders", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), now = Date.now(), executor = new DemoExecutor(store, venue, { now: () => now, maxIntentAgeMs: 30_000 })
  assert.equal(status(await executor.process([intent({ timestamp: now - 30_001 })]), "entry-1"), "rejected")
  assert.equal(venue.submitted.length, 0)
  await executor.process([intent({ timestamp: now })])
  assert.equal(status(await executor.process([intent({ id: "add-1", kind: "add", timestamp: now - 30_001 })]), "add-1"), "rejected")
  assert.equal(venue.markets().length, 1)
})

test("lost writer lease blocks POST and discards late receipts until the next owner reconciles", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue()
  let owns = false
  const executor = new DemoExecutor(store, venue, { beforeSubmit: () => { if (!owns) throw new Error("writer lease lost") } })
  await assert.rejects(executor.process([intent()]), /writer lease lost/)
  assert.equal(venue.submitted.length, 0)
  owns = true
  venue.submit = async (input) => { owns = false; return { status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input), recovered: false } }
  await assert.rejects(executor.process([intent()]), /writer lease lost/)
  assert.equal(venue.markets().length, 1)
  assert.equal(executor.lots().length, 0)
  assert.equal(store.intent(stableClientOrderId("x02", "entry-1"))!.status, "reserved")
  owns = true
  const freshOwner = new DemoExecutor(store, venue, { beforeSubmit: () => { if (!owns) throw new Error("writer lease lost") } })
  await freshOwner.process([intent()])
  assert.equal(venue.markets().length, 1)
  assert.equal(freshOwner.lots()[0].quantity, 2)
})

test("unknown native protection is never resubmitted and blocks another entry", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  venue.conditionalSubmit = async (input) => ({ status: "unknown", clientOrderId: input.clientOrderId, reason: "native conditional reply lost" })
  await executor.process([intent()])
  await executor.process([intent()])
  assert.equal(venue.conditionals().length, 1)
  assert.equal(executor.lots()[0].protection, "unknown")
  const second = intent({ id: "entry-2", positionId: "position-2", laneId: "lane-2" })
  assert.equal(status(await executor.process([second]), second.id), "unknown")
  assert.equal(venue.markets().length, 1)
})

test("native cumulative order fee snapshots replace partial totals without inventing exchange realized PnL", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input, { status: "PARTIALLY_FILLED", filledQuantity: 0.5 }), recovered: false })
  venue.fillOverride = (order) => [{ tradeId: null, granularity: "order", orderId: order.orderId, symbol: order.symbol, side: order.side,
    price: order.averagePrice, quantity: order.filledQuantity, fee: -order.filledQuantity * order.averagePrice * 0.0006, realizedPnl: null, timestamp: Date.now() }]
  await executor.process([intent()])
  assert.equal(executor.summary().fees, 0.03)
  const entry = venue.orders.get(stableClientOrderId("x02", "entry-1"))!
  entry.status = "FILLED"; entry.filledQuantity = 2
  await executor.process([]); await executor.process([])
  assert.equal(executor.summary().fees, 0.12)
  assert.equal(executor.summary().exchangeRealizedPnl, null)
  assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM execution_fill_ledger").get() as { n: number }).n, 1)
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input, { averagePrice: 110 }), recovered: false })
  await executor.process([intent({ kind: "close", id: "close-1" })]); await executor.process([])
  assert.equal(executor.summary().realizedGrossPnl, 20)
  assert.ok(Math.abs(executor.summary().fees! - 0.252) < 1e-10)
  assert.ok(Math.abs(executor.summary().realizedNetPnl! - 19.748) < 1e-10)
  assert.equal(executor.summary().exchangeRealizedPnl, null)
})

test("regressing or over-covered native fee snapshots cannot complete accounting", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  let quantity = 0.5
  venue.submit = async (input) => ({ status: "accepted", clientOrderId: input.clientOrderId, order: makeOrder(input, { status: "PARTIALLY_FILLED", filledQuantity: 0.5 }), recovered: false })
  venue.fillOverride = (order) => [{ tradeId: null, granularity: "order", orderId: order.orderId, symbol: order.symbol, side: order.side,
    price: order.averagePrice, quantity, fee: -quantity * 0.06, realizedPnl: null, timestamp: Date.now() }]
  await executor.process([intent()])
  const entry = venue.orders.get(stableClientOrderId("x02", "entry-1"))!
  entry.status = "FILLED"; entry.filledQuantity = 2
  quantity = 0.25
  await executor.process([])
  assert.equal(executor.summary().fees, null)
  assert.equal(executor.summary().realizedNetPnl, null)
  assert.equal((store.database.prepare("SELECT quantity FROM execution_fill_ledger").get() as { quantity: number }).quantity, 0.5)
  quantity = 3
  await executor.process([])
  assert.equal(executor.summary().fees, null)
  assert.equal((store.database.prepare("SELECT quantity FROM execution_fill_ledger").get() as { quantity: number }).quantity, 0.5)
  quantity = 2
  await executor.process([])
  assert.equal(executor.summary().fees, 0.12)
})

test("300 owned lots reconcile open native orders in one batch without per-order reads or writes", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  const intents = Array.from({ length: 300 }, (_, index) => intent({ id: `entry-${index}`, positionId: `position-${index}`, laneId: `lane-${index}` }))
  await executor.process(intents)
  assert.equal(executor.lots().filter((lot) => lot.quantity > 0).length, 300)
  assert.equal(venue.conditionals().length, 600)
  const writes = venue.submitted.length
  venue.reads.openOrders = 0; venue.reads.orderById = 0
  await executor.process([])
  assert.equal(venue.reads.openOrders, 1)
  assert.equal(venue.reads.orderById, 0)
  assert.equal(venue.submitted.length, writes)
  assert.equal(executor.summary().protectionGaps, 0)
})


test("definite protection failure blocks more exposure but permits owned close", async (t) => {
  const store = new StateStore(":memory:"); t.after(() => store.close())
  const venue = new Venue(), executor = new DemoExecutor(store, venue)
  const original = venue.submitOrder.bind(venue)
  venue.submitOrder = async (input, beforeWrite) => input.type === "STOP_MARKET"
    ? {status:"rejected",clientOrderId:input.clientOrderId,reason:"invalid protection"}
    : original(input,beforeWrite)
  await executor.process([intent()])
  assert.equal(executor.lots()[0].protection,"error")
  const count = venue.submitted.length
  const results = await executor.process([intent({id:"blocked-entry",positionId:"second-position",laneId:"second-lane"}),intent({id:"blocked-add",kind:"add"})])
  assert.equal(results.find(row=>row.id==="blocked-entry")?.status,"unknown")
  assert.equal(results.find(row=>row.id==="blocked-add")?.status,"unknown")
  assert.equal(venue.submitted.length,count)
  const close = await executor.process([intent({id:"close-despite-gap",kind:"close"})])
  assert.equal(close.find(row=>row.id==="close-despite-gap")?.status,"acknowledged")
  assert.equal(executor.lots()[0].quantity,0)
})
