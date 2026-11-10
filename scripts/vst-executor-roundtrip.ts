/** Explicit opt-in, minimum-size, isolated validation of the actual executor. */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { BingxVstClient, type VenueOrder, type VenuePosition } from "../core/bingx"
import { DemoExecutor } from "../core/executor"
import { StateStore } from "../core/store"
import type { ExecutionIntent } from "../core/types"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const inventory = (positions: VenuePosition[], orders: VenueOrder[]) => JSON.stringify({ positions: positions.map((row) => `${row.positionId}:${row.symbol}:${row.direction}:${row.quantity}`).sort(), orders: orders.map((row) => row.orderId).sort() })
async function main() {
  if (!process.argv.includes("--execute")) throw new Error("Pass --execute for the explicitly authorized VST executor diagnostic")
  const venue = new BingxVstClient()
  if (!venue.configured) throw new Error("Dedicated x02 credentials are unavailable")
  const [positions, orders, contracts, quotes, mode] = await Promise.all([venue.positions(), venue.openOrders(), venue.contracts(), venue.quotes(), venue.positionMode()])
  if (mode !== "hedge") throw new Error("Hedge mode is required; no account settings were changed")
  const baseline = inventory(positions, orders), occupied = new Set([...positions, ...orders].map((row) => row.symbol))
  const contract = ["XRP-USDT", "DOGE-USDT", "TRX-USDT", "ADA-USDT", "SOL-USDT"].map((symbol) => contracts.find((row) => row.symbol === symbol)).find((row) => row && !occupied.has(row.symbol) && quotes.some((quote) => quote.symbol === row.symbol))
  if (!contract) throw new Error("No empty diagnostic symbol is available")
  const runId = `executor-${randomUUID()}`, database = path.resolve(process.env.CTS_DATA_DIR || ".data", `${runId}.sqlite`)
  const store = new StateStore(database), executor = new DemoExecutor(store, venue)
  const intents: ExecutionIntent[] = [], results: Record<string, unknown>[] = []
  const triggerMode=process.argv.includes("--trigger")
  async function sameInventory() { const [p, o] = await Promise.all([venue.positions(), venue.openOrders()]); return inventory(p, o) === baseline }
  async function drive(intent: ExecutionIntent) {
    let lastReason = ""
    console.log(JSON.stringify({progress:"starting",kind:intent.kind,direction:intent.direction}))
    for (let poll = 0; poll < 20; poll++) {
      const updates = await executor.process([intent]), result = updates.find((row) => row.id === intent.id)
      if (result?.status === "acknowledged") { console.log(JSON.stringify({progress:"confirmed",kind:intent.kind,direction:intent.direction,poll})); return result }
      if (result?.status === "rejected") throw new Error(`${intent.kind} rejected: ${result.error}`)
      if (result?.error && (result.error !== lastReason || poll % 5 === 0)) { console.log(JSON.stringify({progress:"reconciling",kind:intent.kind,direction:intent.direction,poll,reason:result.error})); lastReason=result.error }
      await pause(300)
    }
    throw new Error(`${intent.kind} still requires reconciliation; no duplicate order was submitted`)
  }
  try {
    for (const direction of (triggerMode ? ["long"] : ["long", "short"]) as ("long"|"short")[]) {
      const price = (await venue.quotes()).find((row) => row.symbol === contract.symbol)!.price
      const scale = 10 ** contract.quantityPrecision
      const quantity = Math.ceil(Math.max(contract.minQuantity, contract.minNotional / price) * scale - 1e-9) / scale
      const entry: ExecutionIntent = { id: `${runId}-${direction}-entry`, kind: "entry", connectionId: "x02", laneId: runId, configId: "diagnostic",
        positionId: `${runId}-${direction}`, symbol: contract.symbol, direction, requestedQuantity: quantity, timestamp: Date.now(), price,
        notional: quantity * price, takeProfitPct: triggerMode ? 0.05 : 3, stopLossPct: triggerMode ? 0.05 : 2, exitMode: "fixed", source: "real-qualified", status: "pending" }
      intents.push(entry)
      await drive(entry)
      let lot = executor.lots().find((row) => row.direction === direction)!
      if (lot.protection !== "active") throw new Error(`Entry protection is ${lot.protection}: ${lot.protectionError || "awaiting confirmation"}`)
      const entryQuantity = lot.quantity
      let addedQuantity=0, nativeTriggerObserved=false
      if(triggerMode){
        console.log(JSON.stringify({progress:"observing-native-trigger",direction,maxObservationSeconds:120}))
        const deadline=Date.now()+120_000
        while(Date.now()<deadline){await executor.process([]);lot=executor.lots().find(row=>row.direction===direction)!;if(lot.quantity<=1e-10){nativeTriggerObserved=true;break}await pause(Math.min(1000,Math.max(0,deadline-Date.now())))}
      } else {
        const add = { ...entry, id: `${runId}-${direction}-add`, kind: "add" as const, timestamp: Date.now(), price: (await venue.quotes()).find((row) => row.symbol === contract.symbol)!.price }
        await drive(add)
        lot = executor.lots().find((row) => row.direction === direction)!
        if (lot.protection !== "active" || lot.quantity <= entryQuantity) throw new Error("DCA add did not produce a larger actual protected lot")
        addedQuantity = lot.quantity - entryQuantity
      }
      const close = { ...entry, id: `${runId}-${direction}-close`, kind: "close" as const, timestamp: Date.now(), requestedQuantity: 999999 }
      await drive(close)
      for (let poll = 0; poll < 10; poll++) {
        await executor.process([])
        lot = executor.lots().find((row) => row.direction === direction)!
        if (lot.quantity <= 1e-10 && lot.protection === "closed" && lot.fees !== null) break
        await pause(300)
      }
      if (lot.quantity > 1e-10 || lot.protection !== "closed") throw new Error("Owned residual position or bracket remains")
      if (lot.fees === null) throw new Error("Exchange fill/fee ledger did not fully reconcile")
      results.push({ direction, symbol: contract.symbol, entryQuantity, addedQuantity, nativeTriggerObserved:triggerMode?nativeTriggerObserved:undefined, closedQuantity: lot.closedQuantity, realizedGrossPnl: lot.realizedGrossPnl,
        fees: lot.fees, realizedNetPnl: lot.realizedNetPnl, exchangeRealizedPnl: lot.exchangeRealizedPnl, protection: lot.protection })
    }
    if (!await sameInventory()) throw new Error("Final inventory differs from the initial inventory")
    console.log(JSON.stringify({ success: true, environment: "BingX VST", runId, results, accounting: executor.summary(), foreignInventoryPreserved: true, residualPositions: 0, residualOrders: 0 }, null, 2))
  } catch (error) {
    let cleanup = "requires reconciliation using the isolated executor journal"
    try {
      await executor.process([])
      for (const entry of intents) {
        const lot = executor.lots().find((row) => row.id === JSON.stringify([entry.connectionId, entry.positionId]))
        if (lot && lot.quantity > 1e-10) await drive({ ...entry, id: `${runId}-${entry.direction}-cleanup`, kind: "close", timestamp: Date.now() })
      }
      await executor.process([])
      if (store.unresolvedIntents().length === 0 && await sameInventory()) cleanup = "completed; final inventory verified equal to baseline"
    } catch { /* Unknown orders cannot be guessed or described as cleaned up. */ }
    console.error(JSON.stringify({ success: false, environment: "BingX VST", runId, results, cleanup, accounting: executor.summary(), reason: error instanceof Error ? error.message : "Executor diagnostic failed" }, null, 2))
    process.exitCode = 1
  } finally { store.close() }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Diagnostic setup failed"); process.exitCode = 1 })
