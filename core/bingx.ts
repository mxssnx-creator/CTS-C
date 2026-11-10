import { createHash, createHmac } from "node:crypto"

/** This module deliberately has no mainnet host or environment switch. */
export const BINGX_VST_HOST = "https://open-api-vst.bingx.com"
export type DemoCredentials = { apiKey: string; apiSecret: string }
export type Direction = "LONG" | "SHORT"
export type PositionSide = Direction | "BOTH"
export type OrderKind = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET"
export type OrderInput = {
  symbol: string
  side: "BUY" | "SELL"
  positionSide: PositionSide
  type: OrderKind
  quantity: string | number
  clientOrderId: string
  price?: string | number
  stopPrice?: string | number
  reduceOnly?: boolean
  stopLoss?: number
  takeProfit?: number
  timeInForce?: "GTC" | "IOC" | "FOK"
}
export type VenueOrder = {
  orderId: string
  triggerOrderId?: string
  clientOrderId: string
  symbol: string
  side: string
  positionSide: string
  type: string
  status: string
  quantity: number
  filledQuantity: number
  averagePrice: number
  price: number
  stopPrice: number
  updateTime: number
  responseFields?: string[]
  attachedOrderIds?: { stopLoss?: string; takeProfit?: string }
}
export type OrderOutcome =
  | { status: "accepted"; clientOrderId: string; order: VenueOrder; recovered: boolean }
  | { status: "rejected"; clientOrderId: string; reason: string }
  | { status: "unknown"; clientOrderId: string; reason: string }
export type Contract = {
  symbol: string
  quantityPrecision: number
  pricePrecision: number
  minQuantity: number
  minNotional: number
  maxLongLeverage: number
  maxShortLeverage: number
  status: string
}
export type Quote = { symbol: string; price: number; timestamp: number }
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }
export type Balance = { asset: string; balance: number; equity: number; availableMargin: number; unrealizedPnl: number }
export type VenuePosition = { positionId: string; symbol: string; direction: Direction; quantity: number; entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number }
export type Commission = { maker: number; taker: number; source: "exchange" }
/** fee is the exchange's signed cash flow: negative values are paid fees. */
export type VenueFill = { tradeId: string | null; orderId: string; symbol: string; side: string; price: number; quantity: number; realizedPnl: number | null; fee: number; timestamp: number; granularity?: "trade" | "order" }
export type ClientOptions = {
  fetch?: typeof globalThis.fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  minRequestIntervalMs?: number
  timeoutMs?: number
}

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {}
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const number = (value: unknown): number => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
const text = (value: unknown): string => value === undefined || value === null ? "" : String(value)

/** Dedicated x02 names only. Generic BINGX_API_KEY must never reach VST. */
export function demoCredentials(env: Record<string, string | undefined> = process.env): DemoCredentials | null {
  const apiKey = (env.BINGX_X02_KEY || env.BINGX_X02_API_KEY || "").trim()
  const apiSecret = (env.BINGX_X02_SECRET || env.BINGX_X02_API_SECRET || "").trim()
  return apiKey && apiSecret ? { apiKey, apiSecret } : null
}

export function stableClientOrderId(connection: string, candidate: string): string {
  if (!connection || !candidate) throw new Error("Connection and candidate identity are required")
  return `ctsc_${createHash("sha256").update(JSON.stringify([connection, candidate])).digest("hex").slice(0, 30)}`
}

export function isOwnedClientOrderId(id: string): boolean {
  return /^ctsc_[a-z0-9_-]{1,35}$/.test(id)
}

export function normalizeSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase().replace(/[\/_]/g, "-")
  const result = normalized.includes("-") ? normalized : normalized.replace(/USDT$/, "-USDT")
  if (!/^[A-Z0-9]{1,20}-USDT$/.test(result)) throw new Error("A valid USDT perpetual symbol is required")
  return result
}

/** Official BingX convention: sign raw values, encode values only on the wire. */
export function signedQuery(params: Record<string, string | number | boolean>, secret: string): string {
  const keys = Object.keys(params).sort()
  const canonical = keys.map((key) => `${key}=${String(params[key])}`).join("&")
  const signature = createHmac("sha256", secret).update(canonical).digest("hex")
  return `${keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`).join("&")}&signature=${signature}`
}

/** Node 24 reviver source retains numeric 64-bit venue IDs without regex edits. */
export function parseVenueJson(input: string): unknown {
  return JSON.parse(input, (key: string, value: unknown, context?: { source?: string }) => {
    if (/^(?:id|orderId|orderID|positionId|positionID|tradeId|transactId|triggerOrderId|parentOrderId|mainOrderId|stopLossOrderId|takeProfitOrderId)$/.test(key) && typeof value === "number") {
      if (context?.source) return context.source
      if (!Number.isSafeInteger(value)) throw new Error("Runtime cannot preserve venue ID precision")
      return String(value)
    }
    return value
  })
}

class VenueError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number, readonly ambiguous: boolean) { super(message) }
}
class WriteGuardError extends Error {
  constructor(readonly original: unknown) { super(original instanceof Error ? original.message : "Exchange write ownership check failed") }
}

function decimal(value: string | number | undefined, label: string): string {
  const result = typeof value === "number" && /e/i.test(String(value)) ? value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") : String(value ?? "")
  if (!/^\d+(?:\.\d+)?$/.test(result) || !(Number(result) > 0) || !Number.isFinite(Number(result))) throw new Error(`${label} must be a positive decimal`)
  return result
}

function parseOrder(input: unknown): VenueOrder {
  const outer = object(input)
  const value = Object.keys(object(outer.order)).length ? object(outer.order) : outer
  const orderId = text(value.orderId ?? value.orderID ?? value.id)
  if (!orderId) throw new Error("Exchange response did not include an order ID")
  return {
    orderId, triggerOrderId: text(value.triggerOrderId) || undefined, clientOrderId: text(value.clientOrderId), symbol: text(value.symbol),
    side: text(value.side), positionSide: text(value.positionSide), type: text(value.type), status: text(value.status),
    quantity: number(value.origQty ?? value.quantity), filledQuantity: number(value.executedQty ?? value.filledQty ?? value.cumQty),
    averagePrice: number(value.avgPrice ?? value.averagePrice), price: number(value.price), stopPrice: number(value.stopPrice),
    updateTime: number(value.updateTime ?? value.time), responseFields: Object.keys(value).sort(),
    attachedOrderIds: {
      stopLoss: text(value.stopLossOrderId ?? object(value.stopLoss).orderId ?? object(value.stopLoss).orderID) || undefined,
      takeProfit: text(value.takeProfitOrderId ?? object(value.takeProfit).orderId ?? object(value.takeProfit).orderID) || undefined,
    },
  }
}

export type CloseInput = { symbol: string; direction: Direction; quantity: string | number; clientOrderId: string; hedgeMode?: boolean }
export type ProtectionInput = CloseInput & { stopLoss?: string | number; takeProfit?: string | number }

/** Callers can persist each returned intent before submitting its POST. */
export function protectionOrders(input: ProtectionInput): OrderInput[] {
  const common = { symbol: normalizeSymbol(input.symbol), side: input.direction === "LONG" ? "SELL" as const : "BUY" as const,
    positionSide: input.hedgeMode === false ? "BOTH" as const : input.direction, quantity: input.quantity, reduceOnly: true }
  if (!isOwnedClientOrderId(input.clientOrderId)) throw new Error("Protection requires a CTS-C client order identity")
  const orders: OrderInput[] = []
  if (input.stopLoss !== undefined) orders.push({ ...common, type: "STOP_MARKET", stopPrice: input.stopLoss, clientOrderId: stableClientOrderId(input.clientOrderId, "stop-loss") })
  if (input.takeProfit !== undefined) orders.push({ ...common, type: "TAKE_PROFIT_MARKET", stopPrice: input.takeProfit, clientOrderId: stableClientOrderId(input.clientOrderId, "take-profit") })
  return orders
}

export class BingxVstClient {
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly interval: number
  private readonly timeout: number
  private schedule: Promise<void> = Promise.resolve()
  private nextStart = 0
  private offset = 0
  private syncedAt = -Infinity
  private syncing: Promise<number> | null = null
  // Suppress concurrent duplicate submissions. Durable lifetime deduplication
  // belongs to the executor's SQLite intent journal, not this transport class.
  private inFlight = new Map<string, Promise<OrderOutcome>>()

  constructor(private readonly credentials: DemoCredentials | null = demoCredentials(), options: ClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.interval = options.minRequestIntervalMs ?? 210
    this.timeout = options.timeoutMs ?? 15_000
    if (this.interval < 0 || this.timeout <= 0) throw new Error("Invalid transport timing configuration")
  }

  get configured(): boolean { return !!(this.credentials?.apiKey && this.credentials?.apiSecret) }

  private async reserveStart(): Promise<() => void> {
    let release!: () => void
    const started = new Promise<void>((resolve) => { release = resolve })
    const slot = this.schedule.then(async () => {
      const wait = Math.max(0, this.nextStart - this.now())
      if (wait) await this.sleep(wait)
      this.nextStart = this.now() + this.interval
      return release
    })
    this.schedule = slot.then(() => started).catch(() => {})
    return slot
  }

  private async request(path: string, params: Record<string, string | number | boolean> = {}, method: "GET" | "POST" | "DELETE" = "GET", authenticated = false, onStart?: (timestamp: number) => void, beforeWrite?: () => void): Promise<unknown> {
    if (authenticated && !this.configured) throw new VenueError("MISSING_CREDENTIALS", "Dedicated x02 credentials are unavailable", 0, false)
    const release = await this.reserveStart()
    try { beforeWrite?.(); onStart?.(this.now()) }
    catch (error) { release(); throw new WriteGuardError(error) }
    const query = authenticated
      ? signedQuery({ ...params, timestamp: Math.floor(this.now() + this.offset - 500), recvWindow: 5000 }, this.credentials!.apiSecret)
      : new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const pending = this.fetcher(`${BINGX_VST_HOST}${path}${query ? `?${query}` : ""}`, {
        method, headers: authenticated ? { "X-BX-APIKEY": this.credentials!.apiKey } : {}, signal: controller.signal,
      })
      release()
      const response = await pending
      const raw = await response.text()
      if (!response.ok) throw new VenueError(String(response.status), `BingX returned HTTP ${response.status}`, response.status, response.status >= 500 || response.status === 408)
      let envelope: RecordValue
      try { envelope = object(parseVenueJson(raw)) } catch { throw new VenueError("INVALID_RESPONSE", "Exchange response could not be verified", response.status, true) }
      if (!(envelope.code === 0 || envelope.code === "0")) {
        const code = text(envelope.code || "INVALID_RESPONSE")
        // Retain the venue's actionable reason without credential/signature
        // echoes. This also distinguishes transient read failures from bad
        // parameters when the exchange reuses a generic error code.
        let detail = text(envelope.msg ?? envelope.message).replace(/[\r\n\t]/g, " ")
        const signature = authenticated ? new URLSearchParams(query).get("signature") : null
        for (const secret of [this.credentials?.apiKey, this.credentials?.apiSecret, signature]) if (secret) detail = detail.replaceAll(secret, "[redacted]")
        detail = detail.replace(/((?:api[_-]?key|api[_-]?secret|signature)\s*[=:]\s*)[^&\s,]+/gi, "$1[redacted]").slice(0, 300)
        throw new VenueError(code, `BingX rejected request (code ${code})${detail ? `: ${detail}` : ""}`, response.status, ["INVALID_RESPONSE", "100500", "109500", "110500", "101481"].includes(code))
      }
      return envelope.data
    } catch (error) {
      if (error instanceof VenueError) throw error
      throw new VenueError("TRANSPORT", "Exchange transport did not confirm the outcome", 0, true)
    } finally { release(); clearTimeout(timer) }
  }

  private async read(path: string, params: Record<string, string | number | boolean> = {}, authenticated = false): Promise<unknown> {
    if (authenticated) await this.ensureClock()
    try { return await this.request(path, params, "GET", authenticated) }
    catch (error) {
      if (!(error instanceof VenueError) || !(error.ambiguous || ["429", "100410", "100429", "100421", "109400"].includes(error.code))) throw error
      if (["100421", "109400"].includes(error.code)) await this.clock()
      else await this.sleep(550)
      return this.request(path, params, "GET", authenticated)
    }
  }

  private async ensureClock(): Promise<void> {
    if (!this.configured) throw new VenueError("MISSING_CREDENTIALS", "Dedicated x02 credentials are unavailable", 0, false)
    if (this.now() - this.syncedAt > 60_000) await this.clock()
  }

  async clock(): Promise<number> {
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      let before = this.now()
      const data = object(await this.request("/openApi/swap/v2/server/time", {}, "GET", false, (started) => { before = started }))
      const after = this.now()
      const serverTime = number(data.serverTime)
      if (!(serverTime > 0)) throw new Error("Exchange did not return a valid clock")
      this.offset = serverTime - (before + after) / 2
      this.syncedAt = after
      return serverTime
    })()
    try { return await this.syncing } finally { this.syncing = null }
  }

  async contracts(): Promise<Contract[]> {
    return rows(await this.read("/openApi/swap/v2/quote/contracts")).map((raw) => {
      const value = object(raw)
      return { symbol: text(value.symbol), quantityPrecision: number(value.quantityPrecision), pricePrecision: number(value.pricePrecision),
        minQuantity: number(value.tradeMinQuantity ?? value.minQty), minNotional: number(value.tradeMinUSDT ?? value.minNotional),
        maxLongLeverage: number(value.maxLongLeverage), maxShortLeverage: number(value.maxShortLeverage), status: text(value.status) }
    }).filter((contract) => /^[A-Z0-9]+-USDT$/.test(contract.symbol))
  }

  async quotes(): Promise<Quote[]> {
    return rows(await this.read("/openApi/swap/v1/ticker/price")).map((raw) => {
      const value = object(raw)
      return { symbol: text(value.symbol), price: number(value.price), timestamp: number(value.time ?? value.timestamp) || this.now() }
    }).filter((quote) => quote.price > 0)
  }

  async candles(symbol: string, interval = "1m", limit = 500, endTime?: number): Promise<Candle[]> {
    if (!["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"].includes(interval)) throw new Error("Unsupported candle interval")
    if (!Number.isInteger(limit) || limit < 1 || limit > 1440) throw new Error("Candle limit must be 1–1440")
    if (endTime !== undefined && (!Number.isSafeInteger(endTime) || endTime <= 0)) throw new Error("Candle end time must be a positive millisecond timestamp")
    const data = await this.read("/openApi/swap/v3/quote/klines", { symbol: normalizeSymbol(symbol), interval, limit, ...(endTime === undefined ? {} : { endTime }) })
    return rows(data).map((raw) => {
      const value = object(raw)
      const row = rows(raw)
      return { time: number(value.time ?? value.timestamp ?? row[0]), open: number(value.open ?? row[1]), high: number(value.high ?? row[2]),
        low: number(value.low ?? row[3]), close: number(value.close ?? row[4]), volume: number(value.volume ?? row[5]) }
    }).filter((candle) => candle.time > 0 && candle.open > 0 && candle.close > 0 && candle.high >= candle.low).sort((a, b) => a.time - b.time)
  }

  async balance(): Promise<Balance> {
    const raw = await this.read("/openApi/swap/v3/user/balance", {}, true)
    const candidates = (Array.isArray(raw) ? raw : [raw]).map((item) => {
      const outer = object(item)
      return Object.keys(object(outer.balance)).length ? object(outer.balance) : outer
    })
    const value = candidates.find((row) => text(row.asset).toUpperCase() === "VST")
      || candidates.find((row) => text(row.asset).toUpperCase() === "USDT")
    if (!value) throw new Error("Exchange returned no VST/USDT balance")
    const balance = Number(value.balance), availableMargin = Number(value.availableMargin)
    const equity = Number(value.equity), unrealizedPnl = Number(value.unrealizedProfit ?? value.unrealizedPnl)
    if ([balance, availableMargin, equity, unrealizedPnl].some((amount) => !Number.isFinite(amount))) throw new Error("Exchange balance fields were not valid")
    return { asset: text(value.asset), balance, equity, availableMargin, unrealizedPnl }
  }

  async positions(symbol?: string): Promise<VenuePosition[]> {
    return rows(await this.read("/openApi/swap/v2/user/positions", symbol ? { symbol: normalizeSymbol(symbol) } : {}, true)).map((raw) => {
      const value = object(raw)
      return { positionId: text(value.positionId), symbol: text(value.symbol), direction: (text(value.positionSide).toUpperCase() === "SHORT" || number(value.positionAmt) < 0 ? "SHORT" : "LONG") as Direction,
        quantity: Math.abs(number(value.positionAmt ?? value.quantity)), entryPrice: number(value.avgPrice ?? value.entryPrice), markPrice: number(value.markPrice),
        unrealizedPnl: number(value.unrealizedProfit ?? value.unrealizedPnl), leverage: number(value.leverage) }
    }).filter((position) => position.quantity > 0)
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const data = await this.read("/openApi/swap/v2/trade/openOrders", symbol ? { symbol: normalizeSymbol(symbol) } : {}, true)
    return rows(Array.isArray(data) ? data : object(data).orders).map(parseOrder)
  }

  async positionMode(): Promise<"hedge" | "one-way"> {
    const data = object(await this.read("/openApi/swap/v1/positionSide/dual", {}, true))
    if (data.dualSidePosition === true || data.dualSidePosition === "true") return "hedge"
    if (data.dualSidePosition === false || data.dualSidePosition === "false") return "one-way"
    throw new Error("Exchange position mode was not recognized")
  }

  async commission(symbol: string): Promise<Commission> {
    const data = object(await this.read("/openApi/swap/v2/user/commissionRate", { symbol: normalizeSymbol(symbol) }, true))
    const value = Object.keys(object(data.commission)).length ? object(data.commission) : data
    const maker = Number(value.makerCommissionRate)
    const taker = Number(value.takerCommissionRate)
    if (!Number.isFinite(maker) || !Number.isFinite(taker) || Math.abs(maker) > 0.1 || taker < 0 || taker > 0.1) throw new Error("Exchange commission rates were not valid")
    return { maker, taker, source: "exchange" }
  }

  /** Exact order attribution only; callers deduplicate persisted trade IDs. */
  async fills(orderId: string, startTs: number, endTs: number): Promise<VenueFill[]> {
    if (!/^\d+$/.test(orderId)) throw new Error("A venue order ID is required for fill reconciliation")
    if (!Number.isSafeInteger(startTs) || !Number.isSafeInteger(endTs) || startTs <= 0 || endTs < startTs) throw new Error("A valid fill reconciliation time range is required")
    try { return await this.tradeFills(orderId, startTs, endTs) }
    catch (error) {
      // Only an explicitly unsupported route permits the less detailed VST
      // order snapshot fallback. Auth, rate, network and malformed data fail.
      if (!(error instanceof VenueError) || !["404", "405"].includes(error.code)) throw error
      return this.orderFillSnapshot(orderId, startTs, endTs)
    }
  }

  private async tradeFills(orderId: string, startTs: number, endTs: number): Promise<VenueFill[]> {
    const pageSize = 100, result = new Map<string, VenueFill>()
    const finite = (value: unknown, field: string): number => {
      if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) throw new Error(`Exchange fill ${field} was missing or invalid`)
      return Number(value)
    }
    let received = 0
    for (let pageIndex = 1; pageIndex <= 1000; pageIndex++) {
      const data = object(await this.read("/openApi/swap/v2/trade/fillHistory", { tradingUnit: "COIN", orderId, startTs, endTs, pageIndex, pageSize }, true))
      const list = data.fill_history_orders
      const total = finite(data.total, "total")
      if (!Array.isArray(list) || !Number.isSafeInteger(total) || total < 0) throw new Error("Exchange fill history response was invalid")
      for (const raw of list) {
        const value = object(raw), actualOrderId = text(value.orderId), tradeId = text(value.tradeId)
        if (actualOrderId !== orderId || !/^\d+$/.test(tradeId)) throw new Error("Exchange fill did not match the exact owned order/trade identity")
        const price = finite(value.price, "price"), quantity = finite(value.qty, "qty"), fee = finite(value.commission, "commission")
        const currency = text(value.commissionAsset).toUpperCase(), side = text(value.side).toUpperCase(), symbol = normalizeSymbol(text(value.symbol))
        const timestamp = typeof value.filledTime === "number" ? value.filledTime : Date.parse(text(value.filledTime))
        if (!["USDT", "VST"].includes(currency) || !["BUY", "SELL"].includes(side) || !(price > 0) || !(quantity > 0) || !Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Exchange fill currency, side, quantity, price or timestamp was invalid")
        const fill: VenueFill = { tradeId, orderId: actualOrderId, symbol, side, price, quantity, realizedPnl: finite(value.realisedPNL, "realisedPNL"), fee, timestamp, granularity: "trade" }
        const existing = result.get(tradeId)
        if (existing && JSON.stringify(existing) !== JSON.stringify(fill)) throw new Error("Exchange repeated a trade identity with inconsistent fill fields")
        result.set(tradeId, fill)
      }
      received += list.length
      if (received >= total) return [...result.values()]
      if (!list.length) throw new Error("Exchange fill history ended before its reported total")
    }
    throw new Error("Exchange fill history exceeded the supported pagination range")
  }

  private async orderFillSnapshot(orderId: string, startTs: number, endTs: number): Promise<VenueFill[]> {
    if (!/^\d+$/.test(orderId)) throw new Error("A venue order ID is required for fill reconciliation")
    if (!Number.isSafeInteger(startTs) || !Number.isSafeInteger(endTs) || startTs <= 0 || endTs < startTs) throw new Error("A valid fill reconciliation time range is required")
    const data = await this.read("/openApi/swap/v2/trade/allFillOrders", { tradingUnit: "COIN", orderId, startTs, endTs }, true)
    const envelope = object(data)
    const list = Array.isArray(data) ? data : envelope.fill_orders ?? envelope.fillOrders ?? envelope.orders
    if (!Array.isArray(list)) throw new Error("Exchange fill response did not contain a recognized fill array")
    const finite = (value: unknown, field: string): number => {
      if ((typeof value !== "number" && typeof value !== "string") || value === "" || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) throw new Error(`Exchange fill ${field} was missing or invalid`)
      return Number(value)
    }
    const hasTradeIdentity = (raw: unknown) => text(object(raw).tradeId) !== ""
    if (list.some(hasTradeIdentity) && !list.every(hasTradeIdentity)) throw new Error("Exchange fill response mixed trade and order granularity")
    if (list.length && !hasTradeIdentity(list[0])) {
      // The VST endpoint currently returns volume/commission rows without a
      // trade ID or realized PnL. Represent the entire requested-order snapshot
      // honestly; inventing trade IDs would double-charge cumulative partials.
      let symbol = "", side = "", currency = "", quantity = 0, notional = 0, fee = 0, timestamp = 0
      for (const raw of list) {
        const value = object(raw)
        if (text(value.orderId) !== orderId) throw new Error("Exchange fill did not match the exact owned order identity")
        const rowSymbol = normalizeSymbol(text(value.symbol)), rowSide = text(value.side).toUpperCase(), rowCurrency = text(value.currency).toUpperCase()
        if (rowSide !== "BUY" && rowSide !== "SELL") throw new Error("Exchange fill side was invalid")
        if (!["USDT", "VST"].includes(rowCurrency) || (currency && currency !== rowCurrency)) throw new Error("Exchange fill commission currency was unsupported or inconsistent")
        if ((symbol && symbol !== rowSymbol) || (side && side !== rowSide)) throw new Error("Exchange order fill rows had inconsistent symbol or side")
        const rowQuantity = finite(value.volume, "volume"), rowPrice = finite(value.price, "price"), rowFee = finite(value.commission, "commission")
        const rowTime = Date.parse(text(value.filledTime ?? value.filledTm))
        if (!(rowQuantity > 0) || !(rowPrice > 0) || !Number.isSafeInteger(rowTime) || rowTime <= 0) throw new Error("Exchange fill volume, price or timestamp was invalid")
        symbol = rowSymbol; side = rowSide; currency = rowCurrency
        quantity += rowQuantity; notional += rowQuantity * rowPrice; fee += rowFee; timestamp = Math.max(timestamp, rowTime)
      }
      if (![quantity, notional, fee].every(Number.isFinite)) throw new Error("Exchange order fill totals were invalid")
      return [{ tradeId: null, orderId, symbol, side, quantity, price: notional / quantity, fee, timestamp, realizedPnl: null, granularity: "order" }]
    }
    return list.map((raw): VenueFill => {
      const value = object(raw)
      const actualOrderId = text(value.orderId)
      const tradeId = text(value.tradeId)
      if (actualOrderId !== orderId || !/^\d+$/.test(tradeId)) throw new Error("Exchange fill did not match the exact owned order/trade identity")
      const price = finite(value.price, "price"), quantity = finite(value.qty, "qty"), timestamp = finite(value.time, "time")
      if (!(price > 0) || !(quantity > 0) || !Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Exchange fill quantity, price or timestamp was invalid")
      const symbol = normalizeSymbol(text(value.symbol)), side = text(value.side).toUpperCase()
      if (side !== "BUY" && side !== "SELL") throw new Error("Exchange fill side was invalid")
      return { tradeId, orderId: actualOrderId, symbol, side, price, quantity, realizedPnl: finite(value.realizedPnl, "realizedPnl"), fee: finite(value.fee, "fee"), timestamp }
    })
  }

  /** Bounded read-only evidence for conditional parent/child investigation.
   * This is diagnostic evidence, never an ownership inference for trading. */
  async historyEvidence(symbol: string, startTime: number, endTime: number): Promise<{orders: Record<string, unknown>[]; fullOrders: Record<string, unknown>[]; orderFills: Record<string, unknown>[]; trades: Record<string, unknown>[]; errors: string[]; truncated: boolean}> {
    symbol = normalizeSymbol(symbol)
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime <= 0 || endTime < startTime || endTime - startTime > 86_400_000) throw new Error("Diagnostic history requires a bounded range of at most one day")
    const fields = new Set(["orderId","orderID","clientOrderId","clientOrderID","triggerOrderId","parentOrderId","symbol","type","side","positionSide","status","origQty","quantity","executedQty","avgPrice","stopPrice","time","updateTime","tradeId","qty","volume","price","amount","commission","currency","commissionAsset","realisedPNL","realizedPnl","fee","filledTime","filledTm","role"])
    const results = await Promise.allSettled([
      this.read("/openApi/swap/v2/trade/allOrders", {symbol,startTime,endTime,limit:100},true),
      this.read("/openApi/swap/v2/trade/allFillOrders", {tradingUnit:"COIN",startTs:startTime,endTs:endTime},true),
      this.read("/openApi/swap/v2/trade/fillHistory", {symbol,tradingUnit:"COIN",startTs:startTime,endTs:endTime,pageIndex:1,pageSize:100},true),
      this.read("/openApi/swap/v1/trade/fullOrder", {symbol,startTime,endTime,limit:100},true),
    ])
    const errors: string[] = []; let truncated = false
    const lists = results.map((result,index) => {
      if (result.status === "rejected") { errors.push(`${["orders","orderFills","trades","fullOrders"][index]}: ${result.reason instanceof Error ? result.reason.message : "Read unavailable"}`); return [] }
      const value = object(result.value)
      const list = Array.isArray(result.value) ? result.value : value.orders ?? value.fill_orders ?? value.fill_history_orders
      if (!Array.isArray(list)) { errors.push(`${["orders","orderFills","trades","fullOrders"][index]}: Unrecognized response shape`); return [] }
      if (list.length >= 100 || number(value.total) > list.length) truncated = true
      return list.map(object).filter(row=>text(row.symbol)===symbol).map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>fields.has(key))))
    })
    return {orders:lists[0],orderFills:lists[1],trades:lists[2],fullOrders:lists[3],errors,truncated}
  }

  async orderByClientId(symbol: string, clientOrderId: string): Promise<VenueOrder | null> {
    if (!isOwnedClientOrderId(clientOrderId)) throw new Error("Only CTS-C order identities may be queried by this executor")
    try {
      const order = parseOrder(await this.read("/openApi/swap/v2/trade/order", { symbol: normalizeSymbol(symbol), clientOrderId }, true))
      if (order.clientOrderId && order.clientOrderId !== clientOrderId) throw new Error("Exchange returned a different client order identity")
      return { ...order, clientOrderId }
    } catch (error) {
      // Only documented missing-order responses are absence. Auth/rate/network
      // failures propagate so they cannot be mistaken for permission to retry.
      if (error instanceof VenueError && error.code === "109421") return null
      throw error
    }
  }

  async reconcileOrder(symbol: string, clientOrderId: string): Promise<OrderOutcome> {
    try {
      const order = await this.orderByClientId(symbol, clientOrderId)
      if (order) return { status: "accepted", clientOrderId, order, recovered: true }
    } catch { /* absence and an unavailable read both keep the write unknown */ }
    return { status: "unknown", clientOrderId, reason: "Entry outcome still requires exchange reconciliation" }
  }

  async submitOrder(input: OrderInput, beforeWrite?: () => void): Promise<OrderOutcome> {
    if (!isOwnedClientOrderId(input.clientOrderId)) throw new Error("CTS-C client order identity is required")
    const current = this.inFlight.get(input.clientOrderId)
    if (current) return current
    const pending = this.submitOnce(input, beforeWrite)
    this.inFlight.set(input.clientOrderId, pending)
    try { return await pending } finally { this.inFlight.delete(input.clientOrderId) }
  }

  private async submitOnce(input: OrderInput, beforeWrite?: () => void): Promise<OrderOutcome> {
    const symbol = normalizeSymbol(input.symbol)
    if (!["BUY", "SELL"].includes(input.side) || !["LONG", "SHORT", "BOTH"].includes(input.positionSide) || !["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(input.type)) throw new Error("Invalid order side or type")
    const supportsClientId = input.type === "MARKET" || input.type === "LIMIT"
    const params: Record<string, string | number | boolean> = { symbol, side: input.side, positionSide: input.positionSide,
      type: input.type, quantity: decimal(input.quantity, "Quantity") }
    if (supportsClientId) params.clientOrderId = input.clientOrderId
    // Attached protection is submitted atomically with the identifiable entry.
    // Native standalone conditional orders do not support clientOrderId.
    if (input.stopLoss !== undefined) params.stopLoss = JSON.stringify({ type: "STOP_MARKET", stopPrice: Number(decimal(input.stopLoss, "Stop loss")), workingType: "MARK_PRICE" })
    if (input.takeProfit !== undefined) params.takeProfit = JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: Number(decimal(input.takeProfit, "Take profit")), workingType: "MARK_PRICE" })
    if (input.positionSide === "BOTH" && input.reduceOnly) params.reduceOnly = true
    if (input.type === "LIMIT") { params.price = decimal(input.price, "Limit price"); params.timeInForce = input.timeInForce || "GTC" }
    if (input.type === "STOP_MARKET" || input.type === "TAKE_PROFIT_MARKET") { params.stopPrice = decimal(input.stopPrice, "Trigger price"); params.workingType = "MARK_PRICE" }
    try { await this.ensureClock() } catch { return { status: "rejected", clientOrderId: input.clientOrderId, reason: "x02 credentials or clock synchronization unavailable; no order submitted" } }
    try {
      // Recheck after both clock sync and rate pacing, immediately before fetch.
      const order = parseOrder(await this.request("/openApi/swap/v2/trade/order", params, "POST", true, undefined, beforeWrite))
      return { status: "accepted", clientOrderId: input.clientOrderId, order: { ...order, clientOrderId: input.clientOrderId }, recovered: false }
    } catch (error) {
      if (error instanceof WriteGuardError) throw error.original
      if (error instanceof VenueError && !error.ambiguous) {
        if (error.code === "100421") this.syncedAt = -Infinity
        return { status: "rejected", clientOrderId: input.clientOrderId, reason: error.message }
      }
      // Do not retry POST, even for a 503, lost response or malformed success.
      return supportsClientId ? this.reconcileOrder(symbol, input.clientOrderId)
        : { status: "unknown", clientOrderId: input.clientOrderId, reason: "Conditional-order response lost; client-ID reconciliation is not supported by BingX. Do not resubmit." }
    }
  }

  async orderById(symbol: string, orderId: string): Promise<VenueOrder> {
    if (!/^\d+$/.test(orderId)) throw new Error("A venue order ID is required")
    const order = parseOrder(await this.read("/openApi/swap/v2/trade/order", { symbol: normalizeSymbol(symbol), orderId }, true))
    if (order.orderId !== orderId && order.triggerOrderId !== orderId) throw new Error("Exchange returned a different order without the exact trigger-parent linkage")
    if (order.symbol && normalizeSymbol(order.symbol) !== normalizeSymbol(symbol)) throw new Error("Exchange order symbol did not match the requested symbol")
    return order
  }

  async cancelOwnedOrder(symbol: string, clientOrderId: string, ownedVenueOrderId?: string, beforeWrite?: () => void): Promise<OrderOutcome> {
    if (!isOwnedClientOrderId(clientOrderId)) throw new Error("A CTS-C journal identity is required")
    // ownedVenueOrderId must come from the caller's persisted accepted intent;
    // it permits cancellation of conditional orders without a venue client ID.
    const order = ownedVenueOrderId ? await this.orderById(symbol, ownedVenueOrderId) : await this.orderByClientId(symbol, clientOrderId)
    if (!order) return { status: "rejected", clientOrderId, reason: "Owned order was not found" }
    if (["FILLED","CANCELED","CANCELLED","EXPIRED","REJECTED"].includes(order.status.toUpperCase())) return {status:"accepted",clientOrderId,order,recovered:true}
    try {
      await this.request("/openApi/swap/v2/trade/order", { symbol: normalizeSymbol(symbol), orderId: order.orderId }, "DELETE", true, undefined, beforeWrite)
      const confirmed = ownedVenueOrderId ? await this.orderById(symbol, ownedVenueOrderId) : await this.orderByClientId(symbol, clientOrderId)
      if (confirmed) return { status: "accepted", clientOrderId, order: confirmed, recovered: false }
      return { status: "unknown", clientOrderId, reason: "Cancellation needs exchange confirmation" }
    } catch (error) {
      if (error instanceof WriteGuardError) throw error.original
      if (ownedVenueOrderId) return { status: "unknown", clientOrderId, reason: "Cancellation needs venue-order reconciliation" }
      return this.reconcileOrder(symbol, clientOrderId)
    }
  }

  closePosition(input: CloseInput): Promise<OrderOutcome> {
    return this.submitOrder({ symbol: input.symbol, quantity: input.quantity, clientOrderId: input.clientOrderId,
      side: input.direction === "LONG" ? "SELL" : "BUY", positionSide: input.hedgeMode === false ? "BOTH" : input.direction, type: "MARKET", reduceOnly: true })
  }

  /** Prefer protectionOrders()+durable executor intents for crash-safe writes. */
  async protectPosition(input: ProtectionInput): Promise<OrderOutcome[]> {
    const outcomes: OrderOutcome[] = []
    for (const order of protectionOrders(input)) outcomes.push(await this.submitOrder(order))
    return outcomes
  }
}
