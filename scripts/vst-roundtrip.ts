/** Isolated VST diagnostic. Run only with --execute; fixed VST adapter. */
import { randomUUID } from "node:crypto"
import { BingxVstClient, demoCredentials, protectionOrders, stableClientOrderId, type OrderInput, type VenueOrder } from "../core/bingx"
import { StateStore } from "../core/store"
import path from "node:path"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function main() {
  if (!process.argv.includes("--execute")) throw new Error("Pass --execute to run the explicitly authorized VST order diagnostic")
  const credentials = demoCredentials()
  if (!credentials) throw new Error("Dedicated x02 credentials unavailable")
  const client = new BingxVstClient(credentials)
  const [contracts, quotes, baselinePositions, baselineOrders, balance, mode] = await Promise.all([client.contracts(), client.quotes(), client.positions(), client.openOrders(), client.balance(), client.positionMode()])
  if (mode !== "hedge") throw new Error("Diagnostic requires hedge mode; no account modes were changed")
  if (!(balance.availableMargin > 0)) throw new Error("No available VST margin")
  const occupied = new Set([...baselinePositions.map((row) => row.symbol), ...baselineOrders.map((row) => row.symbol)])
  const preference = ["XRP-USDT", "DOGE-USDT", "TRX-USDT", "ADA-USDT", "SOL-USDT", "BTC-USDT"]
  const contract = preference.map((symbol) => contracts.find((row) => row.symbol === symbol)).find((row) => row && !occupied.has(row.symbol) && quotes.some((quote) => quote.symbol === row.symbol && quote.price > 0))
  if (!contract) throw new Error("No supported empty symbol is available for isolated verification")
  const quote = quotes.find((row) => row.symbol === contract.symbol)!
  const step = 10 ** -contract.quantityPrecision
  const quantity = Math.ceil((Math.max(contract.minQuantity, contract.minNotional / quote.price) + 1e-12) / step) * step
  if (!(quantity > 0)) throw new Error("Exchange minimum quantity is unavailable")
  const runId = `diagnostic-${randomUUID()}`
  const journal = new StateStore(path.resolve(process.env.CTS_DATA_DIR || ".data", "vst-diagnostic.sqlite"))
  const results: Record<string, unknown>[] = []
  const ownedProtection = new Map<string, VenueOrder>()
  let ownedDirection: "LONG" | "SHORT" | null = null
  let ownedQuantity = 0
  let activeEntry: OrderInput | null = null
  const terminal = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"])
  async function send(input: OrderInput) {
    if (!journal.claimIntent(input.clientOrderId, { runId, input })) throw new Error("Diagnostic client ID was already reserved; reconcile first")
    const outcome = await client.submitOrder(input)
    journal.resolveIntent(input.clientOrderId, outcome.status, { outcome })
    if (outcome.status !== "accepted") throw new Error(`${input.type} outcome ${outcome.status}: ${outcome.reason}`)
    return outcome.order
  }
  async function filled(order: VenueOrder) {
    for (let poll = 0; poll < 20; poll++) {
      const current = await client.orderById(contract!.symbol, order.orderId)
      if (current.filledQuantity > 0 && current.averagePrice > 0 && terminal.has(current.status)) return current
      if (terminal.has(current.status) && current.filledQuantity === 0) throw new Error(`Order ended ${current.status} without a fill`)
      await sleep(250)
    }
    throw new Error("Order fill was not confirmed; keep the diagnostic journal for reconciliation")
  }
  async function closeOwned() {
    if (!ownedDirection || !(ownedQuantity > 0)) return
    const position = (await client.positions(contract!.symbol)).find((row) => row.direction === ownedDirection)
    if (!position) { ownedQuantity = 0; return }
    if (Math.abs(position.quantity - ownedQuantity) > step / 2) throw new Error("Symbol inventory changed outside the diagnostic; no aggregate close sent")
    const close = await send({ symbol: contract!.symbol, side: ownedDirection === "LONG" ? "SELL" : "BUY", positionSide: ownedDirection, type: "MARKET",
      quantity: ownedQuantity.toFixed(contract!.quantityPrecision), reduceOnly: true, clientOrderId: stableClientOrderId(runId, `close-${ownedDirection}`) })
    const confirmed = await filled(close)
    ownedQuantity = Math.max(0, ownedQuantity - confirmed.filledQuantity)
    if (ownedQuantity > step / 2) throw new Error("Diagnostic close was only partially filled")
  }
  async function cancelProtection() {
    for (const [id, order] of ownedProtection) {
      const current = await client.orderById(contract!.symbol, order.orderId)
      if (!terminal.has(current.status)) {
        const canceled = await client.cancelOwnedOrder(contract!.symbol, id, order.orderId)
        if (canceled.status !== "accepted" || !terminal.has(canceled.order.status)) throw new Error("Owned protection cancellation not confirmed")
      }
      ownedProtection.delete(id)
    }
  }
  try {
    for (const direction of ["LONG", "SHORT"] as const) {
      const latest = (await client.quotes()).find((row) => row.symbol === contract.symbol)!
      const sign = direction === "LONG" ? 1 : -1
      const stopLoss = Number((latest.price * (1 - sign * 0.02)).toFixed(contract.pricePrecision))
      const takeProfit = Number((latest.price * (1 + sign * 0.03)).toFixed(contract.pricePrecision))
      // Standalone brackets return exact venue IDs; no symbol-level guessing.
      activeEntry = { symbol: contract.symbol, side: direction === "LONG" ? "BUY" : "SELL", positionSide: direction,
        type: "MARKET", quantity: quantity.toFixed(contract.quantityPrecision), clientOrderId: stableClientOrderId(runId, `entry-${direction}`) }
      const order = await send(activeEntry)
      const entry = await filled(order)
      ownedDirection = direction; ownedQuantity = entry.filledQuantity
      const bracketInputs = protectionOrders({ symbol: contract.symbol, direction, quantity: entry.filledQuantity, clientOrderId: stableClientOrderId(runId, `protection-${direction}`), stopLoss, takeProfit })
      for (const input of bracketInputs) {
        const protection = await send(input)
        ownedProtection.set(input.clientOrderId, protection)
      }
      const nativeOpen = await client.openOrders(contract.symbol)
      const nativeIds = new Set(nativeOpen.map((row) => row.orderId))
      if (![...ownedProtection.values()].every((row) => nativeIds.has(row.orderId))) throw new Error("Native brackets were not both visible on the exchange")
      results.push({ direction, symbol: contract.symbol, minimumQuantity: quantity, filledQuantity: entry.filledQuantity,
        averagePrice: entry.averagePrice, nativeBrackets: ownedProtection.size, responseFields: order.responseFields,
        attachedOrderIdsPresent: Boolean(order.attachedOrderIds?.stopLoss || order.attachedOrderIds?.takeProfit) })
      // Only remove known own bracket IDs before reducing the owned quantity.
      await cancelProtection()
      await closeOwned()
      activeEntry = null
      for (let poll = 0; poll < 10; poll++) {
        const remaining = await client.positions(contract.symbol)
        if (!remaining.length) break
        if (poll === 9) throw new Error("Residual diagnostic position remains")
        await sleep(250)
      }
    }
    const [finalPositions, finalOrders] = await Promise.all([client.positions(), client.openOrders()])
    const positionInventory = (items: typeof finalPositions) => items.map((row) => `${row.positionId}:${row.symbol}:${row.direction}:${row.quantity}`).sort()
    const orderInventory = (items: typeof finalOrders) => items.map((row) => row.orderId).sort()
    if (JSON.stringify(positionInventory(finalPositions)) !== JSON.stringify(positionInventory(baselinePositions)) || JSON.stringify(orderInventory(finalOrders)) !== JSON.stringify(orderInventory(baselineOrders))) throw new Error("Final account inventory differs from the initial inventory")
    console.log(JSON.stringify({ success: true, environment: "BingX VST", runId, results, residualPositions: 0, residualOrders: 0, foreignInventoryPreserved: true }, null, 2))
  } catch (error) {
    let cleanup = "requires reconciliation using the diagnostic journal"
    try {
      if (activeEntry && !(ownedQuantity > 0)) {
        const recovered = await client.orderByClientId(contract.symbol, activeEntry.clientOrderId)
        if (recovered) {
          if (!terminal.has(recovered.status)) await client.cancelOwnedOrder(contract.symbol, activeEntry.clientOrderId, recovered.orderId)
          const final = await client.orderById(contract.symbol, recovered.orderId)
          journal.resolveIntent(activeEntry.clientOrderId, "accepted", { outcome: { status: "accepted", clientOrderId: activeEntry.clientOrderId, order: final, recovered: true } })
          if (final.filledQuantity > 0) { ownedDirection = activeEntry.positionSide as "LONG" | "SHORT"; ownedQuantity = final.filledQuantity }
        }
      }
      await cancelProtection(); await closeOwned()
      const [positions, orders] = await Promise.all([client.positions(), client.openOrders()])
      const inventory = (items: typeof positions) => items.map((row) => `${row.positionId}:${row.symbol}:${row.direction}:${row.quantity}`).sort()
      const ids = (items: typeof orders) => items.map((row) => row.orderId).sort()
      if (journal.unresolvedIntents().length === 0 && JSON.stringify(inventory(positions)) === JSON.stringify(inventory(baselinePositions)) && JSON.stringify(ids(orders)) === JSON.stringify(ids(baselineOrders))) cleanup = "completed; final inventory verified equal to baseline"
    } catch { /* Never describe unverified or ambiguous cleanup as complete. */ }
    console.error(JSON.stringify({ success: false, environment: "BingX VST", runId, results, cleanup, reason: error instanceof Error ? error.message : "Diagnostic failed" }, null, 2))
    process.exitCode = 1
  } finally { journal.close() }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Diagnostic setup failed"); process.exitCode = 1 })
