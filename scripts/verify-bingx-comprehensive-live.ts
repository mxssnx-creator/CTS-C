#!/usr/bin/env tsx
import { nanoid } from "nanoid"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

const EXECUTE = process.argv.includes("--execute")
const SHORT_ONLY = process.argv.includes("--short-only")
const MAX_TEST_NOTIONAL = Number(process.env.BINGX_TEST_MAX_NOTIONAL || "5")
const MARKET_COUNT = 12
const CANDIDATES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT",
  "ADAUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT", "DOTUSDT", "AVAXUSDT",
  "SUIUSDT", "NEARUSDT", "UNIUSDT", "ATOMUSDT", "ETCUSDT", "FILUSDT",
]

type Direction = "LONG" | "SHORT"
type ContractRule = {
  symbol: string
  size: string | number
  quantityPrecision: number
  pricePrecision: number
  tradeMinQuantity: string | number
  tradeMinUSDT: string | number
  status: number | string
}

type MarketCheck = {
  symbol: string
  rule: ContractRule
  bid: number
  ask: number
  last: number
  candles: number
  latencyMs: number
}

type ScenarioState = {
  symbol: string
  direction: Direction
  openedQuantity: number
  entryOrderId?: string
  closeOrderId?: string
  protectionOrderIds: string[]
  positionActive: boolean
  clientPrefix: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function positionQuantity(position: any): number {
  return Math.abs(Number(
    position?.positionAmt ?? position?.positionAmount ?? position?.contracts ??
    position?.quantity ?? position?.size ?? 0,
  ))
}

function positionDirection(position: any): Direction {
  const explicit = String(position?.positionSide ?? position?.side ?? "").toUpperCase()
  if (explicit.includes("SHORT")) return "SHORT"
  if (explicit.includes("LONG")) return "LONG"
  return Number(position?.positionAmt ?? position?.positionAmount ?? 0) < 0 ? "SHORT" : "LONG"
}

function orderId(order: any): string {
  return String(order?.orderId ?? order?.orderID ?? order?.id ?? "")
}

function positionKey(position: any): string {
  return `${normalizedSymbol(position?.symbol)}:${positionDirection(position)}:${positionQuantity(position)}`
}

function roundUpToStep(value: number, step: number, precision: number): number {
  const units = Math.ceil((value - Number.EPSILON) / step)
  return Number((units * step).toFixed(Math.max(0, Math.min(6, precision))))
}

function roundTrigger(value: number, precision: number, direction: "up" | "down"): number {
  const digits = Math.max(0, Math.min(8, Number(precision) || 0))
  const factor = 10 ** digits
  const rounded = direction === "up" ? Math.ceil(value * factor) : Math.floor(value * factor)
  return Number((rounded / factor).toFixed(digits))
}

function findPosition(positions: any[], symbol: string, direction: Direction): any | null {
  return positions.find((position) =>
    normalizedSymbol(position?.symbol) === normalizedSymbol(symbol) &&
    positionQuantity(position) > 0 &&
    positionDirection(position) === direction
  ) || null
}

function createConnector(apiKey: string, apiSecret: string): BingXConnector {
  return new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: false,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    marginType: "cross",
    positionMode: "hedge",
    connectionMethod: "library",
    connectionLibrary: "native",
  })
}

async function waitForPosition(
  connector: BingXConnector,
  symbol: string,
  direction: Direction,
  shouldExist: boolean,
  timeoutMs = 20_000,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  let lastMatch: any | null = null
  let consecutiveAbsent = 0
  do {
    const positions = await connector.getPositions(symbol)
    const match = findPosition(positions, symbol, direction)
    lastMatch = match
    if (shouldExist && match) return match
    if (!shouldExist && !match) {
      consecutiveAbsent += 1
      if (consecutiveAbsent >= 3) return null
    } else {
      consecutiveAbsent = 0
    }
    await sleep(750)
  } while (Date.now() < deadline)
  return shouldExist ? null : lastMatch
}

async function waitForOrdersAbsent(
  connector: BingXConnector,
  symbol: string,
  expectedIds: string[],
  timeoutMs = 15_000,
): Promise<boolean> {
  const expected = new Set(expectedIds)
  const deadline = Date.now() + timeoutMs
  let consecutiveAbsent = 0
  do {
    const orders = await connector.getOpenOrders(symbol)
    const present = orders.some((order) => expected.has(orderId(order)))
    consecutiveAbsent = present ? 0 : consecutiveAbsent + 1
    if (consecutiveAbsent >= 3) return true
    await sleep(750)
  } while (Date.now() < deadline)
  return false
}

async function fetchContracts(): Promise<ContractRule[]> {
  const response = await fetch("https://open-api.bingx.com/openApi/swap/v2/quote/contracts", {
    signal: AbortSignal.timeout(15_000),
  })
  invariant(response.ok, `Contract-rule request failed with HTTP ${response.status}`)
  const payload = await response.json() as { code: number | string; data?: ContractRule[]; msg?: string }
  invariant(String(payload.code) === "0" && Array.isArray(payload.data),
    `Contract-rule request failed: ${payload.msg || payload.code}`)
  return payload.data
}

async function checkMarket(
  connector: BingXConnector,
  symbol: string,
  rule: ContractRule,
): Promise<MarketCheck> {
  let lastError = "unknown"
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = performance.now()
    try {
      const [ticker, candles] = await Promise.all([
        connector.getTicker(symbol),
        connector.getOHLCV(symbol, "1m", 10),
      ])
      invariant(ticker && ticker.bid > 0 && ticker.ask > 0 && ticker.last > 0,
        `${symbol}: invalid ticker`)
      invariant(ticker.ask >= ticker.bid, `${symbol}: crossed ticker`)
      invariant(Array.isArray(candles) && candles.length >= 5, `${symbol}: insufficient OHLCV`)
      invariant(candles.every((row) =>
        Number.isFinite(row.timestamp) && row.open > 0 && row.high > 0 &&
        row.low > 0 && row.close > 0 && row.high >= row.low
      ), `${symbol}: malformed OHLCV`)
      return {
        symbol,
        rule,
        ...ticker,
        candles: candles.length,
        latencyMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < 2) await sleep(750)
    }
  }
  throw new Error(`${symbol}: market readiness failed after retry: ${lastError}`)
}

function executableOrder(check: MarketCheck): { quantity: number; notional: number } | null {
  const step = Number(check.rule.size)
  const minQty = Number(check.rule.tradeMinQuantity || 0)
  const minNotional = Number(check.rule.tradeMinUSDT || 0)
  const price = Math.max(check.ask, check.last)
  if (!(step > 0) || !(price > 0)) return null
  const required = Math.max(step, minQty, minNotional > 0 ? minNotional / price : 0)
  const quantity = roundUpToStep(required, step, Number(check.rule.quantityPrecision || 0))
  const notional = quantity * price
  if (!(quantity > 0) || !(notional > 0) || notional > MAX_TEST_NOTIONAL) return null
  return { quantity, notional }
}

async function runAccountStress(connector: BingXConnector): Promise<{
  cycles: number
  p50Ms: number
  p95Ms: number
}> {
  const latencies: number[] = []
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const started = performance.now()
    const [balance, positions, orders] = await Promise.all([
      connector.getBalance(),
      connector.getPositions(),
      connector.getOpenOrders(),
    ])
    invariant(balance.success, `Authenticated balance stress cycle ${cycle + 1} failed`)
    invariant(Array.isArray(positions) && Array.isArray(orders),
      `Authenticated inventory stress cycle ${cycle + 1} failed`)
    latencies.push(Math.round(performance.now() - started))
    await sleep(500)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    cycles: latencies.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
  }
}

async function cancelTrackedProtection(connector: BingXConnector, state: ScenarioState): Promise<void> {
  const open = await connector.getOpenOrders(state.symbol)
  // Recover exchange IDs for POSTs whose HTTP response timed out after BingX
  // accepted them. Only this run's unique prefix is eligible for cleanup.
  for (const order of open) {
    const client = String(order?.clientOrderId ?? order?.client_oid ?? "")
    const id = orderId(order)
    if (client.startsWith(state.clientPrefix) && id && !state.protectionOrderIds.includes(id)) {
      state.protectionOrderIds.push(id)
    }
  }
  if (state.protectionOrderIds.length === 0) return
  const openIds = new Set(open.map(orderId))
  for (const id of state.protectionOrderIds) {
    if (!openIds.has(id)) continue
    const result = await connector.cancelOrder(state.symbol, id)
    if (!result.success) {
      // Cancellation responses are ambiguous under transport timeout. Verify
      // venue absence before treating the cancellation as failed.
      await sleep(650)
      const afterAmbiguousCancel = await connector.getOpenOrders(state.symbol)
      invariant(!afterAmbiguousCancel.some((order) => orderId(order) === id),
        `${state.symbol}: failed to cancel a tracked protection order: ${result.error || "unknown"}`)
    }
    await sleep(650)
  }
  invariant(await waitForOrdersAbsent(connector, state.symbol, state.protectionOrderIds),
    `${state.symbol}: tracked protection order remained after cancellation`)
}

async function emergencyCleanup(
  connector: BingXConnector,
  state: ScenarioState,
  hedgeMode: boolean,
): Promise<void> {
  try {
    await cancelTrackedProtection(connector, state)
  } catch (error) {
    console.error(JSON.stringify({
      phase: "cleanup-protection",
      success: false,
      symbol: state.symbol,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  if (!state.positionActive) return
  try {
    const residual = await waitForPosition(connector, state.symbol, state.direction, true, 2_500)
    if (!residual) {
      state.positionActive = false
      return
    }
    const residualQty = Math.min(positionQuantity(residual), state.openedQuantity || Number.POSITIVE_INFINITY)
    const close = await connector.placeOrder(
      state.symbol,
      state.direction === "LONG" ? "sell" : "buy",
      residualQty,
      undefined,
      "market",
      {
        reduceOnly: true,
        positionSide: hedgeMode ? state.direction : undefined,
        hedgeMode,
        clientOrderId: `ctsc_emg_${Date.now()}_${nanoid(4)}`,
      },
    )
    invariant(close.success, `${state.symbol}: emergency close failed: ${close.error || "unknown"}`)
    invariant(!(await waitForPosition(connector, state.symbol, state.direction, false)),
      `${state.symbol}: residual position remained after emergency close`)
    state.positionActive = false
  } catch (error) {
    console.error(JSON.stringify({
      phase: "cleanup-position",
      success: false,
      symbol: state.symbol,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

async function runScenario(
  primary: BingXConnector,
  apiKey: string,
  apiSecret: string,
  check: MarketCheck,
  direction: Direction,
  hedgeMode: boolean,
): Promise<{ symbol: string; direction: Direction; quantity: number; notional: number }> {
  const executable = executableOrder(check)
  invariant(executable, `${check.symbol}: contract minimum exceeds guarded notional`)
  const runId = `ctsc_${Date.now()}_${nanoid(5)}`
  const state: ScenarioState = {
    symbol: check.symbol,
    direction,
    openedQuantity: executable.quantity,
    protectionOrderIds: [],
    positionActive: false,
    clientPrefix: runId,
  }

  try {
    const [positionsAtStart, ordersAtStart] = await Promise.all([
      primary.getPositions(check.symbol),
      primary.getOpenOrders(check.symbol),
    ])
    invariant(!findPosition(positionsAtStart, check.symbol, direction),
      `${check.symbol}: selected direction became occupied before entry`)
    invariant(ordersAtStart.length === 0, `${check.symbol}: selected symbol acquired an open order before entry`)

    const entrySide = direction === "LONG" ? "buy" : "sell"
    const closeSide = direction === "LONG" ? "sell" : "buy"
    // Once the POST starts its outcome is potentially ambiguous until venue
    // inventory proves otherwise. Cleanup must inspect the position even when
    // the HTTP response times out.
    state.positionActive = true
    const entry = await primary.placeOrder(check.symbol, entrySide, executable.quantity, undefined, "market", {
      positionSide: hedgeMode ? direction : undefined,
      hedgeMode,
      clientOrderId: `${runId}_e`,
    })
    invariant(entry.success && entry.orderId, `${check.symbol}: entry failed: ${entry.error || "missing order id"}`)
    state.entryOrderId = entry.orderId

    const position = await waitForPosition(primary, check.symbol, direction, true)
    invariant(position, `${check.symbol}: accepted entry position could not be verified`)
    state.openedQuantity = positionQuantity(position)
    invariant(state.openedQuantity > 0, `${check.symbol}: verified entry quantity is zero`)
    const entryPrice = Number(position?.avgPrice ?? position?.entryPrice ?? entry.filledPrice ?? check.last)
    invariant(entryPrice > 0, `${check.symbol}: entry price unavailable`)

    const pricePrecision = Number(check.rule.pricePrecision || 0)
    const stopLoss = direction === "LONG"
      ? roundTrigger(entryPrice * 0.92, pricePrecision, "down")
      : roundTrigger(entryPrice * 1.08, pricePrecision, "up")
    const takeProfit = direction === "LONG"
      ? roundTrigger(entryPrice * 1.08, pricePrecision, "up")
      : roundTrigger(entryPrice * 0.92, pricePrecision, "down")
    invariant(stopLoss > 0 && takeProfit > 0 && stopLoss !== takeProfit,
      `${check.symbol}: invalid protection trigger calculation`)

    const [sl, tp] = await Promise.all([
      primary.placeStopOrder(
        check.symbol, closeSide, state.openedQuantity, stopLoss, "stop_loss", {
          reduceOnly: true,
          positionSide: hedgeMode ? direction : undefined,
          hedgeMode,
          clientOrderId: `${runId}_sl`,
        },
      ),
      primary.placeStopOrder(
        check.symbol, closeSide, state.openedQuantity, takeProfit, "take_profit", {
          reduceOnly: true,
          positionSide: hedgeMode ? direction : undefined,
          hedgeMode,
          clientOrderId: `${runId}_tp`,
        },
      ),
    ])
    if (sl.success && sl.orderId) state.protectionOrderIds.push(sl.orderId)
    if (tp.success && tp.orderId) state.protectionOrderIds.push(tp.orderId)
    invariant(sl.success && sl.orderId, `${check.symbol}: stop-loss placement failed: ${sl.error || "missing order id"}`)
    invariant(tp.success && tp.orderId, `${check.symbol}: take-profit placement failed: ${tp.error || "missing order id"}`)

    // Tracking diagnostics run only after both exchange-side protection legs
    // exist, so API latency can no longer extend the unprotected interval.
    await sleep(650)
    const entryDetail = await primary.getOrderDetails(check.symbol, state.entryOrderId)
    invariant(entryDetail.success && entryDetail.order, `${check.symbol}: entry tracking query failed`)

    const openProtection = await primary.getOpenOrders(check.symbol)
    const openProtectionIds = new Set(openProtection.map(orderId))
    invariant(state.protectionOrderIds.every((id) => openProtectionIds.has(id)),
      `${check.symbol}: not all protection orders were visible in open-order inventory`)

    // A fresh connector instance proves that exchange-side identifiers, position
    // state and protection orders survive an application-instance restart.
    const resumed = createConnector(apiKey, apiSecret)
    const resumedMode = await resumed.getPositionMode()
    invariant(resumedMode.success && resumedMode.hedgeMode === hedgeMode,
      `${check.symbol}: fresh-instance position mode differs`)
    const resumedPositions = await resumed.getPositions(check.symbol)
    invariant(findPosition(resumedPositions, check.symbol, direction),
      `${check.symbol}: fresh instance could not recover the live position`)
    await sleep(650)
    const recoveredSl = await resumed.getOrderDetails(check.symbol, state.protectionOrderIds[0])
    invariant(recoveredSl.success && recoveredSl.order, `${check.symbol}: fresh instance could not recover stop-loss`)
    await sleep(650)
    const recoveredTp = await resumed.getOrderDetails(check.symbol, state.protectionOrderIds[1])
    invariant(recoveredTp.success && recoveredTp.order, `${check.symbol}: fresh instance could not recover take-profit`)

    await cancelTrackedProtection(resumed, state)

    const close = await resumed.placeOrder(check.symbol, closeSide, state.openedQuantity, undefined, "market", {
      reduceOnly: true,
      positionSide: hedgeMode ? direction : undefined,
      hedgeMode,
      clientOrderId: `${runId}_c`,
    })
    invariant(close.success && close.orderId, `${check.symbol}: close failed: ${close.error || "missing order id"}`)
    state.closeOrderId = close.orderId
    invariant(!(await waitForPosition(resumed, check.symbol, direction, false)),
      `${check.symbol}: position remained after verified close`)
    state.positionActive = false

    const finalSymbolOrders = await resumed.getOpenOrders(check.symbol)
    invariant(finalSymbolOrders.length === 0, `${check.symbol}: open order remained after scenario cleanup`)
    await sleep(650)
    const closeDetail = await resumed.getOrderDetails(check.symbol, state.closeOrderId)
    invariant(closeDetail.success && closeDetail.order, `${check.symbol}: close tracking query failed`)
    await sleep(650)
    const history = await resumed.getOrderHistory(check.symbol, 20)
    const historyIds = new Set(history.map(orderId))
    invariant(historyIds.has(state.entryOrderId) && historyIds.has(state.closeOrderId),
      `${check.symbol}: entry/close continuity missing from order history`)

    return {
      symbol: check.symbol,
      direction,
      quantity: state.openedQuantity,
      notional: Number((state.openedQuantity * entryPrice).toFixed(6)),
    }
  } finally {
    await emergencyCleanup(primary, state, hedgeMode)
  }
}

async function main() {
  const apiKey = process.env.BINGX_API_KEY?.trim() || ""
  const apiSecret = process.env.BINGX_API_SECRET?.trim() || ""
  invariant(apiKey.length >= 10 && apiSecret.length >= 10, "BINGX credentials are missing")
  invariant(Number.isFinite(MAX_TEST_NOTIONAL) && MAX_TEST_NOTIONAL > 0 && MAX_TEST_NOTIONAL <= 5,
    "BINGX_TEST_MAX_NOTIONAL must be greater than 0 and no more than 5 USDT")

  const connector = createConnector(apiKey, apiSecret)
  const connection = await connector.testConnection()
  invariant(connection.success, `Credential/readiness test failed: ${connection.error || "unknown"}`)
  const freeUsdt = connection.balances?.find((item) => item.asset === "USDT")?.free ?? connection.balance
  const guardedCapacity = freeUsdt > 0 ? freeUsdt : connection.balance
  invariant(guardedCapacity > 0, "No positive USDT wallet capacity was reported")

  const mode = await connector.getPositionMode()
  invariant(mode.success && typeof mode.hedgeMode === "boolean",
    `Could not verify account position mode: ${mode.error || "unknown"}`)

  const [positionsBeforeRaw, ordersBefore, contracts] = await Promise.all([
    connector.getPositions(),
    connector.getOpenOrders(),
    fetchContracts(),
  ])
  const positionsBefore = positionsBeforeRaw.filter((position) => positionQuantity(position) > 0)
  const occupied = new Set([
    ...positionsBefore.map((position) => normalizedSymbol(position.symbol)),
    ...ordersBefore.map((order) => normalizedSymbol(order.symbol)),
  ])
  const activeRuleBySymbol = new Map(
    contracts
      .filter((rule) => String(rule.status) === "1")
      .map((rule) => [normalizedSymbol(rule.symbol), rule]),
  )
  const readinessSymbols = CANDIDATES.filter((symbol) => activeRuleBySymbol.has(symbol)).slice(0, MARKET_COUNT)
  invariant(readinessSymbols.length === MARKET_COUNT, `Only ${readinessSymbols.length}/${MARKET_COUNT} readiness symbols are active`)

  const marketChecks = await Promise.all(readinessSymbols.map((symbol) =>
    checkMarket(connector, symbol, activeRuleBySymbol.get(symbol)!),
  ))
  const stress = await runAccountStress(connector)
  const executable = marketChecks
    .filter((check) => !occupied.has(normalizedSymbol(check.symbol)) && executableOrder(check))
    .sort((a, b) => executableOrder(a)!.notional - executableOrder(b)!.notional)
  invariant(executable.length >= 2, "Fewer than two isolated symbols fit the guarded maximum notional")
  const requiredFreeMargin = Math.max(
    executableOrder(executable[0])!.notional,
    executableOrder(executable[1])!.notional,
  ) * 1.25
  invariant(guardedCapacity > requiredFreeMargin,
    "Wallet capacity is too low for the selected minimum order plus 25% reserve")

  const sortedMarketLatency = marketChecks.map((check) => check.latencyMs).sort((a, b) => a - b)
  console.log(JSON.stringify({
    phase: "readiness",
    success: true,
    mainnet: true,
    authenticated: true,
    execute: EXECUTE,
    marketsChecked: marketChecks.length,
    marketLatencyP50Ms: sortedMarketLatency[Math.floor(sortedMarketLatency.length * 0.5)],
    marketLatencyP95Ms: sortedMarketLatency[Math.floor(sortedMarketLatency.length * 0.95)],
    accountStress: stress,
    existingPositions: positionsBefore.length,
    existingOpenOrders: ordersBefore.length,
    isolatedExecutableSymbols: executable.length,
    maxPerPositionNotional: MAX_TEST_NOTIONAL,
    availableMarginPositive: freeUsdt > 0,
    guardedCapacitySource: freeUsdt > 0 ? "available-margin" : "positive-test-wallet",
  }))

  if (!EXECUTE) return

  const results = []
  if (!SHORT_ONLY) {
    results.push(await runScenario(connector, apiKey, apiSecret, executable[0], "LONG", mode.hedgeMode))
    await sleep(1_000)
  }
  results.push(await runScenario(
    connector,
    apiKey,
    apiSecret,
    executable[SHORT_ONLY ? 0 : 1],
    "SHORT",
    mode.hedgeMode,
  ))
  await sleep(1_000)

  const [positionsAfterRaw, ordersAfter] = await Promise.all([
    connector.getPositions(),
    connector.getOpenOrders(),
  ])
  const positionsAfter = positionsAfterRaw.filter((position) => positionQuantity(position) > 0)
  const beforePositionKeys = [...positionsBefore.map(positionKey)].sort()
  const afterPositionKeys = [...positionsAfter.map(positionKey)].sort()
  const beforeOrderIds = [...ordersBefore.map(orderId)].filter(Boolean).sort()
  const afterOrderIds = [...ordersAfter.map(orderId)].filter(Boolean).sort()
  invariant(JSON.stringify(afterPositionKeys) === JSON.stringify(beforePositionKeys),
    "Unrelated position inventory changed during the isolated test")
  invariant(JSON.stringify(afterOrderIds) === JSON.stringify(beforeOrderIds),
    "Unrelated open-order inventory changed during the isolated test")

  console.log(JSON.stringify({
    phase: "completed",
    success: true,
    liveScenarios: results,
    restartRecoveryVerified: true,
    restartRecoveryScenarios: results.length,
    protectionsPlacedTrackedAndCancelled: results.length * 2,
    residualTestPositions: 0,
    residualTestOrders: 0,
    unrelatedPositionInventoryPreserved: true,
    unrelatedOrderInventoryPreserved: true,
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({
    phase: "failed",
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exit(1)
})
