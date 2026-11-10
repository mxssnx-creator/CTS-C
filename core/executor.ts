import { BingxVstClient, normalizeSymbol, protectionOrders, stableClientOrderId, type Contract, type OrderInput, type OrderOutcome, type VenueFill, type VenueOrder, type VenuePosition } from "./bingx"
import { getStore, StateStore, type Intent as JournalIntent } from "./store"
import type { ExecutionIntent } from "./types"
import {describeProfitFactor} from './metrics'

export interface ExecutionUpdate { id: string; status: "acknowledged" | "rejected" | "unknown"; exchangeOrderId?: string; error?: string }
export interface OwnedLot {
  id: string; connectionId: string; laneId: string; symbol: string; direction: "long" | "short"
  quantity: number; averageEntry: number; openedQuantity: number; closedQuantity: number
  realizedGrossPnl: number; fees: number | null; realizedNetPnl: number | null; exchangeRealizedPnl: number | null; updatedAt: number
  protection: "pending" | "active" | "unknown" | "error" | "closed"; protectionError?: string
  executionIntent: ExecutionIntent; protectionGeneration?: number
  openedNotional?:number
  entryQuantityScale?:number
}
export interface ExecutorVenue {
  readonly configured: boolean
  readonly environment?:string
  contracts(): Promise<Contract[]>
  positionMode(): Promise<"hedge" | "one-way">
  positions(symbol?: string): Promise<VenuePosition[]>
  openOrders(symbol?: string): Promise<VenueOrder[]>
  submitOrder(order: OrderInput, beforeWrite?: () => void): Promise<OrderOutcome>
  reconcileOrder(symbol: string, clientId: string): Promise<OrderOutcome>
  orderById(symbol: string, orderId: string): Promise<VenueOrder>
  cancelOwnedOrder(symbol: string, clientId: string, venueId?: string, beforeWrite?: () => void): Promise<OrderOutcome>
  fills(orderId: string, startTs: number, endTs: number): Promise<VenueFill[]>
}
interface Payload { intent: ExecutionIntent; order: OrderInput; role?: "protection" | "residual"; parentId?: string; generation?: string }
interface Receipt { outcome: OrderOutcome; appliedQuantity: number; appliedNotional: number; feeQuantity?: number; feeError?: string }
class ExecutionDeferred extends Error {}
class AlreadyClosed extends Error {}
class IntentCanceledBeforeWrite extends Error {}
const LOTS_KEY = "executor:owned-lots"
const TERMINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"])
const EPSILON = 1e-10
function receipt(row: JournalIntent): Receipt | undefined { return row.result as unknown as Receipt | undefined }
function payload(row: JournalIntent): Payload { return row.payload as unknown as Payload }
function lotId(intent: ExecutionIntent): string { return JSON.stringify([intent.connectionId, intent.positionId]) }
function terminal(order: VenueOrder) { return TERMINAL.has(order.status.toUpperCase()) }
function quantityAtPrecision(value: number, precision: number, round: "up" | "down"): number {
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) throw new Error("Invalid exchange quantity precision")
  const scale = 10 ** precision
  return (round === "up" ? Math.ceil(value * scale - 1e-9) : Math.floor(value * scale + 1e-9)) / scale
}

/** Durable intent -> one POST -> exact order/fill reconciliation. Conditional
 * orders have native IDs of their own; no attribution by aggregate position.
 */
export class DemoExecutor {
  private tail: Promise<unknown> = Promise.resolve()
  private contractCache = new Map<string, Contract>()
  private contractsAt = 0
  private cycleRows: Map<string, JournalIntent> | null = null
  private cycleLots: Record<string, OwnedLot> | null = null
  private cycleIndex = new Map<string, Map<string, JournalIntent>>()
  constructor(readonly store: StateStore = getStore(), readonly venue: ExecutorVenue = new BingxVstClient(), readonly options: { beforeSubmit?: () => void; validateIntent?: (intent: ExecutionIntent) => void; now?: () => number; maxIntentAgeMs?: number;connectionId?:string } = {}) {
    store.database.exec("CREATE TABLE IF NOT EXISTS execution_fill_ledger(order_id TEXT NOT NULL,trade_id TEXT NOT NULL,lot_id TEXT NOT NULL,quantity REAL NOT NULL,fee REAL NOT NULL,realized_pnl REAL,data TEXT NOT NULL,PRIMARY KEY(order_id,trade_id)); CREATE INDEX IF NOT EXISTS execution_fill_ledger_lot ON execution_fill_ledger(lot_id);")
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private guard = () => { this.options.beforeSubmit?.() }
  private allLots(): Record<string, OwnedLot> { return this.cycleLots ?? this.store.get<Record<string, OwnedLot>>(LOTS_KEY) ?? {} }
  private saveLots(all: Record<string, OwnedLot>) { if (this.cycleLots) this.cycleLots = all; this.store.set(LOTS_KEY, all) }
  lots(): OwnedLot[] { return Object.values(this.allLots()) }
  private lot(intent: ExecutionIntent) { return this.allLots()[lotId(intent)] }
  private rows(): JournalIntent[] { return [...(this.cycleRows?.values() ?? this.store.openExecutionIntents())].filter((row) => row.status !== "rejected" && row.payload.intent && row.payload.order) }
  private findRow(id: string): JournalIntent | undefined { return this.cycleRows?.get(id) ?? this.store.intent(id) }
  private refreshRow(id: string) {
    if (!this.cycleRows) return
    const row = this.store.intent(id)
    if (!row) return
    this.cycleRows.set(id, row)
    if (row.payload.intent && row.payload.order) {
      const key = lotId(payload(row).intent), index = this.cycleIndex.get(key) ?? new Map<string, JournalIntent>()
      index.set(id, row); this.cycleIndex.set(key, index)
    }
  }
  private beginCycle() {
    this.cycleRows = new Map(); this.cycleIndex.clear()
    for (const row of this.store.openExecutionIntents()) {
      this.cycleRows.set(row.id, row)
      if (!row.payload.intent || !row.payload.order) continue
      const key = lotId(payload(row).intent), index = this.cycleIndex.get(key) ?? new Map<string, JournalIntent>()
      index.set(row.id, row); this.cycleIndex.set(key, index)
    }
    this.cycleLots = this.store.get<Record<string, OwnedLot>>(LOTS_KEY) ?? {}
  }
  private active(row: JournalIntent): boolean { const out = receipt(row)?.outcome; return !out || out.status === "unknown" || (out.status === "accepted" && !terminal(out.order)) }
  private related(intent: ExecutionIntent) { return this.cycleRows
    ? [...(this.cycleIndex.get(lotId(intent))?.values() ?? [])].filter((row) => row.status !== "rejected")
    : this.rows().filter((row) => lotId(payload(row).intent) === lotId(intent)) }
  private update(row: JournalIntent): ExecutionUpdate {
    const intent = payload(row).intent, out = receipt(row)?.outcome
    if (out?.status === "accepted") {
      const lot = this.lot(intent)
      if (intent.kind === "close" && (lot?.quantity ?? 0) > EPSILON) return { id: intent.id, status: "unknown", exchangeOrderId: out.order.orderId, error: "Owned close is not complete; residual quantity remains under reconciliation" }
      if (!terminal(out.order)) return { id: intent.id, status: "unknown", exchangeOrderId: out.order.orderId, error: "Order accepted; awaiting final actual fills" }
      if (out.order.filledQuantity === 0) return { id: intent.id, status: "rejected", exchangeOrderId: out.order.orderId, error: `Order ended ${out.order.status} without a fill` }
      return { id: intent.id, status: "acknowledged", exchangeOrderId: out.order.orderId }
    }
    if (out?.status === "rejected") return { id: intent.id, status: "rejected", error: out.reason }
    return { id: intent.id, status: "unknown", error: out?.reason || "Durable order intent awaits exchange reconciliation" }
  }
  summary() {
    const counts = this.store.database.prepare("SELECT status,COUNT(*) AS count FROM intents GROUP BY status").all() as { status: string; count: number }[]
    const lots = this.lots(), complete = lots.every((lot) => lot.fees !== null), exchangeComplete = lots.every((lot) => lot.exchangeRealizedPnl !== null)
    const resultPF=(qualifiedOnly:boolean)=>{
      let profit=0,loss=0,closed=0,incomplete=0
      for(const lot of lots){
        if(lot.quantity>EPSILON||lot.openedQuantity<=0||(qualifiedOnly&&!lot.executionIntent.qualificationId))continue
        let notional=lot.openedNotional
        if(notional===undefined){
          const row=this.store.database.prepare("SELECT SUM(quantity) AS quantity,SUM(quantity*json_extract(data,'$.price')) AS notional FROM execution_fill_ledger WHERE lot_id=? AND upper(json_extract(data,'$.side'))=?").get(lot.id,lot.direction==='long'?'BUY':'SELL') as {quantity:number|null;notional:number|null}
          if(row.quantity!==null&&Math.abs(row.quantity-lot.openedQuantity)<EPSILON)notional=row.notional??undefined
        }
        if(lot.realizedNetPnl===null||lot.fees===null||!notional||!Number.isFinite(notional)){incomplete++;continue}
        const value=100*lot.realizedNetPnl/notional;profit+=Math.max(0,value);loss+=Math.max(0,-value);closed++
      }
      return {closed,incomplete,...describeProfitFactor(profit,loss,closed)}
    }
    return { configured: this.venue.configured, environment: this.venue.environment??'BingX VST', intents: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
      executionPF:resultPF(false),validatedExecutionPF:resultPF(true),
      ownedLots: lots.filter((lot) => lot.quantity > EPSILON).length, realizedGrossPnl: lots.reduce((sum, lot) => sum + lot.realizedGrossPnl, 0),
      fees: complete ? lots.reduce((sum, lot) => sum + (lot.fees ?? 0), 0) : null,
      realizedNetPnl: complete ? lots.reduce((sum, lot) => sum + (lot.realizedNetPnl ?? 0), 0) : null,
      exchangeRealizedPnl: exchangeComplete ? lots.reduce((sum, lot) => sum + (lot.exchangeRealizedPnl ?? 0), 0) : null,
      protectionGaps: lots.filter((lot) => lot.quantity > EPSILON && lot.protection !== "active").length,
      accounting: complete ? "Owned fills and signed exchange commissions reconciled; net excludes funding" : "Awaiting complete exchange fill/commission records; missing fees are not estimated" }
  }
  process(intents: ExecutionIntent[]): Promise<ExecutionUpdate[]> {
    const run = this.tail.then(async () => {
      this.beginCycle()
      try { return await this.processSerial(intents) }
      finally { this.cycleRows = null; this.cycleLots = null; this.cycleIndex.clear() }
    }); this.tail = run.catch(() => {}); return run
  }
  private async processSerial(intents: ExecutionIntent[]): Promise<ExecutionUpdate[]> {
    if (!this.venue.configured) return intents.map((intent) => ({ id: intent.id, status: "unknown", error: "Dedicated x02 credentials unavailable; no order submitted" }))
    const byId = new Map((await this.reconcile()).map((result) => [result.id, result]))
    for (const intent of intents) {
      const clientId = stableClientOrderId(intent.connectionId, intent.id), previous = this.findRow(clientId)
      if (previous) { byId.set(intent.id, this.update(previous)); continue }
      try {
        const order = await this.prepare(intent, clientId)
        await this.send({ intent, order })
        await this.ensureProtection(intent)
        const saved = this.findRow(clientId)
        if (saved) byId.set(intent.id, this.update(saved))
      } catch (error) {
        if (error instanceof AlreadyClosed) byId.set(intent.id, { id: intent.id, status: "acknowledged" })
        else byId.set(intent.id, { id: intent.id, status: error instanceof ExecutionDeferred ? "unknown" : this.store.intent(clientId) ? "unknown" : "rejected", error: error instanceof Error ? error.message : "Execution unavailable" })
      }
    }
    await this.reconcileFees()
    return [...byId.values()]
  }
  private async send(data: Payload): Promise<void> {
    if(this.options.connectionId&&data.intent.connectionId!==this.options.connectionId)throw new Error('Execution journal belongs to another connection')
    const id = data.order.clientOrderId
    if (this.findRow(id)) return
    this.guard()
    if (!this.store.claimIntent(id, data as unknown as Record<string, unknown>)) { this.refreshRow(id); return }
    this.refreshRow(id)
    this.guard()
    const validateWrite = () => {
      this.guard()
      if (!data.role && data.intent.kind !== "close") {
        try {
          if (this.now() - data.intent.timestamp > (this.options.maxIntentAgeMs ?? 180_000)) throw new Error("Intent expired while exchange preflight was pending")
          this.options.validateIntent?.(data.intent)
        } catch (error) { throw new IntentCanceledBeforeWrite(error instanceof Error ? error.message : "Execution intent is no longer eligible") }
      }
    }
    let outcome: OrderOutcome
    try { outcome = await this.venue.submitOrder(data.order, validateWrite) }
    catch (error) { outcome = error instanceof IntentCanceledBeforeWrite
      ? { status: "rejected", clientOrderId: id, reason: `Canceled before exchange write: ${error.message}` }
      : { status: "unknown", clientOrderId: id, reason: "Submission outcome unknown; reconciliation required" } }
    this.guard() // A process that lost its lease must not apply the late receipt.
    this.apply(id, outcome)
  }
  async reconcile(): Promise<ExecutionUpdate[]> {
    if (!this.venue.configured) return []
    if (!this.cycleRows) return this.process([])
    const activeRows = this.rows().filter((row) => this.active(row))
    let open: Map<string, VenueOrder> | null = null
    if (activeRows.some((row) => receipt(row)?.outcome.status === "accepted")) {
      try { open = new Map((await this.venue.openOrders()).map((order) => [order.orderId, order])) } catch { /* Exact-ID reads remain available. */ }
    }
    for (const row of activeRows) {
      const previous = receipt(row)?.outcome
      if (!this.active(row)) continue
      // BingX does not support client IDs on conditional orders. A lost native
      // ID remains unknown; symbol/side matching could capture another lane.
      if (payload(row).role === "protection" && previous?.status !== "accepted") continue
      let outcome: OrderOutcome
      try {
        if (previous?.status === "accepted") {
          let order = open?.get(previous.order.orderId)
          if (!order || order.filledQuantity + EPSILON < (receipt(row)?.appliedQuantity ?? 0) || (order.filledQuantity > 0 && !(order.averagePrice > 0))) order = await this.venue.orderById(payload(row).order.symbol, previous.order.orderId)
          outcome = { status: "accepted", clientOrderId: row.id, order, recovered: true }
        } else outcome = await this.venue.reconcileOrder(payload(row).order.symbol, row.id)
      } catch { continue }
      if (previous?.status === "accepted" && outcome.status === "unknown") continue
      if (previous?.status === "accepted" && outcome.status === "accepted" && JSON.stringify(previous.order) === JSON.stringify(outcome.order)) continue
      this.guard(); this.apply(row.id, outcome)
    }
    await this.resumeResidualCloses()
    for (const lot of this.lots()) {
      try { await this.ensureProtection(lot.executionIntent) }
      catch (error) { if (error instanceof ExecutionDeferred) this.protectionState(lot.id, "unknown", error.message); else throw error }
    }
    await this.reconcileFees()
    return this.rows().filter((row) => !payload(row).role).map((row) => this.update(row))
  }
  private async contract(symbol: string): Promise<Contract> {
    if (this.now() - this.contractsAt > 60_000 || !this.contractCache.size) {
      let contracts: Contract[]
      try { contracts = await this.venue.contracts() } catch (error) { throw new ExecutionDeferred(`Contract metadata read unavailable: ${error instanceof Error ? error.message : "unknown error"}`) }
      this.contractCache = new Map(contracts.map((row) => [row.symbol, row])); this.contractsAt = this.now()
    }
    const contract = this.contractCache.get(symbol)
    if (!contract) throw new Error("Symbol is absent from current VST contract metadata")
    return contract
  }
  private async assertInventory(intent: ExecutionIntent): Promise<void> {
    const symbol = normalizeSymbol(intent.symbol), lots = this.lots()
    const ambiguous = this.rows().some((row) => payload(row).order.symbol === symbol && payload(row).intent.direction === intent.direction && (!receipt(row) || receipt(row)?.outcome.status === "unknown"))
    if (ambiguous) throw new ExecutionDeferred("An order for this symbol/direction remains unknown; reconcile it before another write")
    const tracked = lots.filter((lot) => lot.connectionId === intent.connectionId && lot.symbol === symbol && lot.direction === intent.direction).reduce((sum, lot) => sum + lot.quantity, 0)
    let positions: VenuePosition[], orders: VenueOrder[]
    try { [positions, orders] = await Promise.all([this.venue.positions(symbol), this.venue.openOrders(symbol)]) }
    catch (error) { throw new ExecutionDeferred(`Position/order inventory read unavailable: ${error instanceof Error ? error.message : "unknown error"}`) }
    const actual = positions.filter((row) => row.symbol === symbol && row.direction === intent.direction.toUpperCase()).reduce((sum, row) => sum + row.quantity, 0)
    const tolerance = Math.max(EPSILON, Math.abs(tracked) * 1e-9)
    if (Math.abs(actual - tracked) > tolerance) throw new ExecutionDeferred("Exchange quantity differs from owned lots; this symbol and direction are isolated until reconciled")
    const ownedIds = new Set(this.rows().flatMap(row => { const out=receipt(row)?.outcome; return out?.status === "accepted" ? [out.order.orderId] : [] }))
    const external = orders.some(order => {
      if (order.symbol && order.symbol !== symbol) return false
      const side = order.positionSide.toUpperCase()
      return (!side || side === "BOTH" || side === intent.direction.toUpperCase() || (side !== "LONG" && side !== "SHORT")) && !ownedIds.has(order.orderId)
    })
    if (external) throw new ExecutionDeferred("An unrelated open order shares this symbol and direction; no position-changing write was sent")
  }
  private async prepare(intent: ExecutionIntent, clientId: string): Promise<OrderInput> {
    if(this.options.connectionId&&intent.connectionId!==this.options.connectionId)throw new Error('Intent belongs to another connection')
    if (intent.source !== "real-qualified" || !intent.positionId || !intent.laneId || !intent.connectionId) throw new Error("A qualified, lane-owned execution intent is required")
    const now = this.now()
    if (intent.kind !== "close" && (now - intent.timestamp > (this.options.maxIntentAgeMs ?? 180_000) || intent.timestamp > now + 10_000)) throw new Error("Entry/add intent is stale or future-dated; no order submitted")
    if (!(intent.price > 0) || !Number.isFinite(intent.price)) throw new Error("Intent has no valid price")
    if(intent.maxOrderNotional!==undefined&&(!Number.isFinite(intent.maxOrderNotional)||intent.maxOrderNotional<0))throw new Error('Invalid order notional cap')
    if (intent.kind !== "close") {
      if (!(intent.requestedQuantity > 0) || !Number.isFinite(intent.requestedQuantity) || !(intent.stopLossPct > 0) || !Number.isFinite(intent.stopLossPct)) throw new Error("Positive finite quantity and stop-loss distance are required")
      const existingGap = this.lots().some((lot) => lot.connectionId === intent.connectionId && lot.symbol === normalizeSymbol(intent.symbol) && lot.direction === intent.direction && lot.quantity > EPSILON && (lot.protection === "error" || lot.protection === "unknown"))
      if (existingGap) throw new ExecutionDeferred("Existing exposure has unresolved protection; new entries/adds are blocked until it is protected or closed")
    }
    let mode: "hedge" | "one-way"
    try { mode = await this.venue.positionMode() } catch (error) { throw new ExecutionDeferred(`Position mode read unavailable: ${error instanceof Error ? error.message : "unknown error"}`) }
    if (mode !== "hedge") throw new Error("Independent long/short execution requires hedge mode")
    const symbol = normalizeSymbol(intent.symbol), contract = await this.contract(symbol)
    let owned = this.lot(intent)
    if(intent.minimumAddRatio!==undefined&&(!Number.isFinite(intent.minimumAddRatio)||intent.minimumAddRatio<=0))throw new Error('Invalid relative addition size')
    const minimumRatio=intent.kind==='entry'?Math.min(1,intent.minimumAddRatio??1):1
    const requested=intent.requestedQuantity*(intent.kind==='add'?(owned?.entryQuantityScale??1):1)
    const openingQuantity=intent.kind==='close'?0:quantityAtPrecision(intent.kind==='add'?requested:Math.max(requested,contract.minQuantity/minimumRatio,contract.minNotional/intent.price/minimumRatio),contract.quantityPrecision,'up')
    if(intent.kind==='add'&&(openingQuantity+EPSILON<contract.minQuantity||openingQuantity*intent.price+EPSILON<contract.minNotional))throw new Error('Scaled addition is below the exchange minimum; its intended ratio cannot be placed')
    // Reject excessive new risk before touching an existing lot's protective orders.
    if(intent.kind!=='close'&&intent.maxOrderNotional&&openingQuantity*intent.price>intent.maxOrderNotional+EPSILON)throw new Error('Exchange-normalized size exceeds the configured order notional cap')
    if (owned && (owned.laneId !== intent.laneId || owned.symbol !== symbol || owned.direction !== intent.direction)) throw new Error("Execution intent does not own this lot")
    if (owned && intent.kind === "entry") throw new Error("This position already owns a lot; use a qualified add intent")
    if (this.related(intent).some((row) => payload(row).role !== "protection" && this.active(row))) throw new ExecutionDeferred("Earlier order for this lot still awaits a final fill")
    if (intent.kind !== "entry") {
      if (!owned) throw new Error("No filled CTS-C lot exists for this position")
      if (owned.quantity <= EPSILON) { if (intent.kind === "close") throw new AlreadyClosed(); throw new Error("Cannot add to a closed owned lot") }
      await this.assertInventory(intent)
      await this.cancelProtection(intent)
      owned = this.lot(intent)
      if (!owned || owned.quantity <= EPSILON) { if (intent.kind === "close") throw new AlreadyClosed(); throw new Error("Protection closed this lot before the add") }
    }
    await this.assertInventory(intent)
    const closing = intent.kind === "close"
    if (!closing && (!(intent.requestedQuantity > 0) || !Number.isFinite(intent.requestedQuantity) || !(intent.stopLossPct > 0))) throw new Error("Positive quantity and stop-loss distance are required")
    const quantity = closing ? quantityAtPrecision(owned!.quantity, contract.quantityPrecision, "down")
      : openingQuantity
    if (!(quantity > 0)) throw new Error("Owned/requested quantity is below exchange precision")
    const direction = intent.direction === "long" ? "LONG" as const : "SHORT" as const
    return { symbol, side: closing ? direction === "LONG" ? "SELL" : "BUY" : direction === "LONG" ? "BUY" : "SELL", positionSide: direction,
      type: "MARKET", quantity: quantity.toFixed(contract.quantityPrecision), clientOrderId: clientId, reduceOnly: closing }
  }
  private protectionState(id: string, state: OwnedLot["protection"], error?: string) {
    const all = this.allLots()
    if (all[id] && (all[id].protection !== state || all[id].protectionError !== error)) { this.guard(); all[id].protection = state; all[id].protectionError = error; this.saveLots(all) }
  }
  private async cancelProtection(intent: ExecutionIntent): Promise<void> {
    for (const row of this.related(intent).filter((row) => payload(row).role === "protection" && this.active(row))) {
      const out = receipt(row)?.outcome
      if (out?.status !== "accepted") throw new ExecutionDeferred("Conditional response is unknown; its native ID must be reconciled before resizing this lot")
      this.guard()
      let canceled: OrderOutcome
      try { canceled = await this.venue.cancelOwnedOrder(payload(row).order.symbol, row.id, out.order.orderId, this.guard) }
      catch (error) { throw new ExecutionDeferred(`Owned protection preflight/cancellation unavailable: ${error instanceof Error ? error.message : "unknown error"}`) }
      this.guard()
      if (canceled.status !== "accepted") throw new ExecutionDeferred("Owned protection cancellation is not confirmed")
      this.apply(row.id, canceled)
      if (!terminal(canceled.order)) throw new ExecutionDeferred("Owned protection remains active; no position-changing write sent")
      const all = this.allLots()
      const current = all[lotId(intent)]
      if (current) { current.protectionGeneration = (current.protectionGeneration ?? 0) + 1; current.protection = current.quantity > EPSILON ? "pending" : "closed"; this.saveLots(all) }
    }
  }
  private async ensureProtection(intent: ExecutionIntent): Promise<void> {
    let lot = this.lot(intent)
    if (!lot) return
    if (lot.quantity <= EPSILON) { await this.cancelProtection(intent); this.protectionState(lot.id, "closed"); return }
    if (this.related(intent).some((row) => payload(row).intent.kind === "close" && payload(row).role !== "protection" && this.active(row))) return
    const generation = stableClientOrderId(lot.id, `${lot.openedQuantity}:${lot.closedQuantity}:${lot.averageEntry}:${lot.protectionGeneration ?? 0}`)
    const existing = this.related(intent).filter((row) => payload(row).role === "protection" && this.active(row))
    if (existing.some((row) => payload(row).generation !== generation)) { await this.cancelProtection(intent); return this.ensureProtection(intent) }
    const contract = await this.contract(lot.symbol), sign = lot.direction === "long" ? 1 : -1
    const configuration = lot.executionIntent
    const inputs = protectionOrders({ symbol: lot.symbol, direction: lot.direction === "long" ? "LONG" : "SHORT", quantity: lot.quantity.toFixed(contract.quantityPrecision), clientOrderId: generation,
      stopLoss: Number((lot.averageEntry * (1 - sign * configuration.stopLossPct / 100)).toFixed(contract.pricePrecision)),
      takeProfit: configuration.exitMode === "fixed" && configuration.takeProfitPct > 0 ? Number((lot.averageEntry * (1 + sign * configuration.takeProfitPct / 100)).toFixed(contract.pricePrecision)) : undefined })
    if (inputs.some((order) => !this.findRow(order.clientOrderId))) {
      await this.assertInventory(intent)
      this.protectionState(lot.id, "pending")
    }
    for (const order of inputs) {
      const synthetic: ExecutionIntent = { ...configuration, kind: "close", id: order.clientOrderId }
      await this.send({ intent: synthetic, order, role: "protection", generation })
      const out = receipt(this.findRow(order.clientOrderId)!)?.outcome
      if (out?.status !== "accepted") { this.protectionState(lot.id, out?.status === "rejected" ? "error" : "unknown", out?.reason || "Protection native ID is unknown"); return }
      if (terminal(out.order)) {
        if (out.order.filledQuantity > 0) { await this.cancelProtection(intent); this.protectionState(lot.id, this.lot(intent)!.quantity <= EPSILON ? "closed" : "pending"); return }
        this.protectionState(lot.id, "error", "Native protection ended without a fill"); return
      }
    }
    this.protectionState(lot.id, "active")
  }
  private async resumeResidualCloses(): Promise<void> {
    for (const root of this.rows().filter((row) => !payload(row).role && payload(row).intent.kind === "close")) {
      const out = receipt(root)?.outcome, intent = payload(root).intent
      let lot = this.lot(intent)
      if (out?.status !== "accepted" || !terminal(out.order) || !lot || lot.quantity <= EPSILON) continue
      if (this.related(intent).some((row) => payload(row).role !== "protection" && this.active(row))) continue
      try {
        await this.assertInventory(intent)
        await this.cancelProtection(intent); lot = this.lot(intent)!
        if (lot.quantity <= EPSILON) continue
        await this.assertInventory(intent)
        const contract = await this.contract(lot.symbol)
        const clientOrderId = stableClientOrderId(root.id, `residual:${lot.closedQuantity}`)
        const order: OrderInput = { ...payload(root).order, quantity: lot.quantity.toFixed(contract.quantityPrecision), clientOrderId }
        await this.send({ intent, order, role: "residual", parentId: root.id })
      } catch (error) { if (!(error instanceof ExecutionDeferred)) throw error; this.protectionState(lot.id, "unknown", error.message) }
    }
  }
  private apply(id: string, outcome: OrderOutcome): void {
    this.guard(); this.store.database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.findRow(id)
      if (!row) throw new Error("Missing durable intent")
      const data = payload(row), intent = data.intent, prior = receipt(row)
      let appliedQuantity = prior?.appliedQuantity || 0, appliedNotional = prior?.appliedNotional || 0
      if (outcome.status === "accepted") {
        const order = outcome.order
        if ((order.symbol && normalizeSymbol(order.symbol) !== data.order.symbol) || (order.side && order.side.toUpperCase() !== data.order.side) || (order.positionSide && order.positionSide.toUpperCase() !== data.order.positionSide)) throw new Error("Exchange order symbol/side does not match the owned intent")
        const earlier = prior?.outcome
        if (earlier?.status === "accepted" && order.orderId !== earlier.order.orderId && order.triggerOrderId !== earlier.order.orderId) throw new Error("Changed venue order ID has no exact owned trigger-parent link")
        const filled = order.filledQuantity, average = order.averagePrice
        if (filled > Number(data.order.quantity) + EPSILON) throw new Error("Exchange fill exceeds the requested owned order quantity")
        if (!Number.isFinite(filled) || filled < appliedQuantity - EPSILON) throw new Error("Exchange cumulative fill quantity decreased")
        if (filled > appliedQuantity + EPSILON) {
          if (!(average > 0) || !Number.isFinite(average)) throw new Error("Filled order has no confirmed average price")
          const delta = filled - appliedQuantity, notional = filled * average, deltaNotional = notional - appliedNotional
          if (!(deltaNotional > 0)) throw new Error("Exchange cumulative fill notional decreased")
          const all = this.allLots(), key = lotId(intent)
          let lot = all[key]
          if (!lot) {
            if (intent.kind !== "entry") throw new Error("Cannot apply a fill to an unowned lot")
            lot = { id: key, connectionId: intent.connectionId, laneId: intent.laneId, symbol: normalizeSymbol(intent.symbol), direction: intent.direction,
              quantity: 0, averageEntry: 0, openedQuantity: 0, closedQuantity: 0,openedNotional:0, realizedGrossPnl: 0, fees: null, realizedNetPnl: null, exchangeRealizedPnl: null,
              updatedAt: this.now(), protection: "pending", executionIntent: intent }
          }
          if (lot.laneId !== intent.laneId || lot.symbol !== normalizeSymbol(intent.symbol) || lot.direction !== intent.direction) throw new Error("Cross-lane fill assignment rejected")
          if (intent.kind === "close") {
            if (delta > lot.quantity + EPSILON) throw new Error("Confirmed close exceeds the owned lot")
            lot.realizedGrossPnl += (deltaNotional - delta * lot.averageEntry) * (lot.direction === "long" ? 1 : -1)
            const remaining=lot.quantity-delta;lot.quantity=remaining<=EPSILON?0:remaining;lot.closedQuantity += delta
          } else {
            lot.averageEntry = (lot.averageEntry * lot.quantity + deltaNotional) / (lot.quantity + delta)
            lot.quantity += delta; lot.openedQuantity += delta; lot.executionIntent = intent
            if(intent.kind==='entry')lot.entryQuantityScale=filled/intent.requestedQuantity
            if(lot.openedNotional!==undefined)lot.openedNotional+=deltaNotional
          }
          lot.fees = null; lot.realizedNetPnl = null; lot.exchangeRealizedPnl = null
          lot.updatedAt = this.now(); all[key] = lot; this.saveLots(all)
          appliedQuantity = filled; appliedNotional = notional
        }
      }
      this.store.resolveIntent(id, outcome.status, { ...prior, outcome, appliedQuantity, appliedNotional })
      this.store.database.exec("COMMIT"); this.refreshRow(id)
    } catch (error) { this.store.database.exec("ROLLBACK"); throw error }
  }
  private async reconcileFees(): Promise<void> {
    for (const row of this.rows()) {
      const previous = receipt(row), out = previous?.outcome
      if (out?.status !== "accepted" || !(previous!.appliedQuantity > (previous!.feeQuantity ?? 0) + EPSILON)) continue
      try {
        const fills = await this.venue.fills(out.order.orderId, Math.max(1, row.createdAt - 60_000), Math.max(row.createdAt + 1, this.now()))
        this.guard(); this.store.database.exec("BEGIN IMMEDIATE")
        try {
          const key = lotId(payload(row).intent)
          for (const fill of fills) {
            if (fill.orderId !== out.order.orderId || fill.symbol !== payload(row).order.symbol) throw new Error("Fill does not belong to the exact owned order")
            const identity = fill.granularity === "order" ? "order-summary" : `trade:${fill.tradeId}`
            if (fill.granularity === "order") {
              const old = this.store.database.prepare("SELECT quantity,trade_id FROM execution_fill_ledger WHERE order_id=?").all(fill.orderId) as {quantity:number;trade_id:string}[]
              if (old.some((row) => row.trade_id !== identity || row.quantity > fill.quantity + EPSILON)) throw new Error("Cumulative fee snapshot regressed or changed granularity")
              this.store.database.prepare("INSERT INTO execution_fill_ledger VALUES(?,?,?,?,?,?,?) ON CONFLICT(order_id,trade_id) DO UPDATE SET quantity=excluded.quantity,fee=excluded.fee,realized_pnl=excluded.realized_pnl,data=excluded.data").run(fill.orderId, identity, key, fill.quantity, fill.fee, fill.realizedPnl, JSON.stringify(fill))
            } else {
              if (!fill.tradeId) throw new Error("An individual execution needs an actual venue trade ID")
              if (this.store.database.prepare("SELECT 1 FROM execution_fill_ledger WHERE order_id=? AND trade_id='order-summary'").get(fill.orderId)) throw new Error("Fee accounting granularity changed")
              this.store.database.prepare("INSERT OR IGNORE INTO execution_fill_ledger VALUES(?,?,?,?,?,?,?)").run(fill.orderId, identity, key, fill.quantity, fill.fee, fill.realizedPnl, JSON.stringify(fill))
            }
          }
          const totals = this.store.database.prepare("SELECT COALESCE(SUM(quantity),0) AS quantity FROM execution_fill_ledger WHERE order_id=?").get(out.order.orderId) as { quantity: number }
          if (totals.quantity > previous!.appliedQuantity + EPSILON) throw new Error("Fill ledger exceeds the order's confirmed cumulative quantity")
          this.store.resolveIntent(row.id, row.status, { ...previous, feeQuantity: totals.quantity, feeError: undefined })
          this.store.database.exec("COMMIT"); this.refreshRow(row.id)
        } catch (error) { this.store.database.exec("ROLLBACK"); throw error }
      } catch (error) {
        this.guard(); this.store.resolveIntent(row.id, row.status, { ...previous, feeError: error instanceof Error ? error.message : "Fee reconciliation unavailable" }); this.refreshRow(row.id)
      }
    }
    this.guard()
    const all = this.allLots(), orders = this.rows()
    for (const lot of Object.values(all)) {
      const related = orders.filter((row) => lotId(payload(row).intent) === lot.id)
      const complete = related.every((row) => (receipt(row)?.appliedQuantity || 0) <= (receipt(row)?.feeQuantity || 0) + EPSILON)
      const totals = this.store.database.prepare("SELECT COALESCE(SUM(fee),0) AS fee,SUM(realized_pnl) AS pnl,COUNT(*) AS count,COUNT(realized_pnl) AS pnl_count FROM execution_fill_ledger WHERE lot_id=?").get(lot.id) as { fee: number; pnl: number | null; count: number; pnl_count: number }
      lot.fees = complete ? -totals.fee : null
      lot.exchangeRealizedPnl = complete && totals.count === totals.pnl_count ? totals.pnl : null
      lot.realizedNetPnl = complete ? lot.realizedGrossPnl - (lot.fees ?? 0) : null
    }
    this.saveLots(all)
  }
}
