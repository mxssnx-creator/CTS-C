#!/usr/bin/env tsx
import { nanoid } from "nanoid"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

const EXECUTE = process.argv.includes("--execute")
const MAX_TEST_NOTIONAL = Number(process.env.BINGX_TEST_MAX_NOTIONAL || "5")
const CANDIDATES = ["XRPUSDT", "TRXUSDT", "DOGEUSDT", "SOLUSDT", "ETHUSDT", "BTCUSDT"]

type ContractRule = {
  symbol: string
  size: string | number
  quantityPrecision: number
  tradeMinQuantity: number
  tradeMinUSDT: number
  status: number
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function positionQuantity(position: any): number {
  return Math.abs(Number(position?.positionAmt ?? position?.positionAmount ?? position?.contracts ?? position?.quantity ?? position?.size ?? 0))
}

function roundUpToStep(value: number, step: number, precision: number): number {
  const units = Math.ceil((value - Number.EPSILON) / step)
  return Number((units * step).toFixed(Math.max(0, precision)))
}

async function waitForPosition(
  connector: BingXConnector,
  symbol: string,
  shouldExist: boolean,
  timeoutMs = 20_000,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  let lastMatch: any | null = null
  let consecutiveAbsent = 0
  do {
    const positions = await connector.getPositions(symbol)
    const match = positions.find((position) =>
      normalizedSymbol(position.symbol) === normalizedSymbol(symbol) &&
      positionQuantity(position) > 0 &&
      String(position.positionSide ?? position.side ?? "LONG").toUpperCase().includes("LONG")
    )
    lastMatch = match || null
    if (shouldExist && match) return match
    if (!shouldExist && !match) {
      consecutiveAbsent++
      if (consecutiveAbsent >= 3) return null
    } else {
      consecutiveAbsent = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  } while (Date.now() < deadline)
  return shouldExist ? null : lastMatch
}

async function main() {
  const apiKey = process.env.BINGX_API_KEY?.trim() || ""
  const apiSecret = process.env.BINGX_API_SECRET?.trim() || ""
  if (apiKey.length < 10 || apiSecret.length < 10) throw new Error("BINGX credentials are missing")
  if (!Number.isFinite(MAX_TEST_NOTIONAL) || MAX_TEST_NOTIONAL <= 0 || MAX_TEST_NOTIONAL > 5) {
    throw new Error("BINGX_TEST_MAX_NOTIONAL must be greater than 0 and no more than 5 USDT")
  }

  const connector = new BingXConnector({
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

  const connection = await connector.testConnection()
  if (!connection.success) throw new Error(`Credential/readiness test failed: ${connection.error || "unknown error"}`)
  if (!(connection.balance > MAX_TEST_NOTIONAL)) throw new Error("Balance is too low for the guarded minimum-order test")

  const mode = await connector.getPositionMode()
  if (!mode.success || typeof mode.hedgeMode !== "boolean") throw new Error(`Could not verify account position mode: ${mode.error || "unknown"}`)

  const [positionsBefore, ordersBefore, contractResponse] = await Promise.all([
    connector.getPositions(),
    connector.getOpenOrders(),
    fetch("https://open-api.bingx.com/openApi/swap/v2/quote/contracts", { signal: AbortSignal.timeout(15_000) }),
  ])
  if (!contractResponse.ok) throw new Error(`Contract-rule request failed with HTTP ${contractResponse.status}`)
  const contractPayload = await contractResponse.json() as { code: number | string; data?: ContractRule[]; msg?: string }
  if (String(contractPayload.code) !== "0" || !Array.isArray(contractPayload.data)) {
    throw new Error(`Contract-rule request failed: ${contractPayload.msg || contractPayload.code}`)
  }

  const occupied = new Set([
    ...positionsBefore.filter((position) => positionQuantity(position) > 0).map((position) => normalizedSymbol(position.symbol)),
    ...ordersBefore.map((order) => normalizedSymbol(order.symbol)),
  ])

  let selected: { symbol: string; quantity: number; price: number; notional: number } | null = null
  for (const symbol of CANDIDATES) {
    if (occupied.has(normalizedSymbol(symbol))) continue
    const rule = contractPayload.data.find((item) => normalizedSymbol(item.symbol) === normalizedSymbol(symbol) && Number(item.status) === 1)
    if (!rule) continue
    const ticker = await connector.getTicker(symbol)
    const price = Number(ticker?.ask || ticker?.last || 0)
    const step = Number(rule.size)
    const minimum = Math.max(Number(rule.tradeMinQuantity || 0), Number(rule.tradeMinUSDT || 0) / price)
    if (!(price > 0) || !(step > 0) || !(minimum > 0)) continue
    const quantity = roundUpToStep(minimum, step, Number(rule.quantityPrecision || 0))
    const notional = quantity * price
    if (notional > 0 && notional <= MAX_TEST_NOTIONAL) {
      selected = { symbol, quantity, price, notional }
      break
    }
  }
  if (!selected) throw new Error("No isolated liquid symbol fits the guarded maximum notional")

  console.log(JSON.stringify({
    phase: "preflight",
    authenticated: true,
    mainnet: true,
    nativeConnector: true,
    hedgeMode: mode.hedgeMode,
    existingPositions: positionsBefore.filter((position) => positionQuantity(position) > 0).length,
    existingOpenOrders: ordersBefore.length,
    selected: {
      symbol: selected.symbol,
      quantity: selected.quantity,
      estimatedNotional: Number(selected.notional.toFixed(4)),
    },
    execute: EXECUTE,
  }))

  if (!EXECUTE) return

  const clientOrderId = `ctsv_${Date.now()}_${nanoid(6)}`
  let openedQuantity = selected.quantity
  let entrySucceeded = false
  try {
    const entry = await connector.placeOrder(selected.symbol, "buy", selected.quantity, undefined, "market", {
      clientOrderId,
      hedgeMode: mode.hedgeMode,
      positionSide: mode.hedgeMode ? "LONG" : undefined,
    })
    if (!entry.success) throw new Error(`Entry order failed: ${entry.error || "unknown error"}`)
    entrySucceeded = true

    const openPosition = await waitForPosition(connector, selected.symbol, true)
    if (!openPosition) throw new Error("Entry was accepted but the isolated position could not be verified")
    openedQuantity = positionQuantity(openPosition) || selected.quantity

    const close = await connector.placeOrder(selected.symbol, "sell", openedQuantity, undefined, "market", {
      reduceOnly: true,
      positionSide: mode.hedgeMode ? "LONG" : undefined,
      hedgeMode: mode.hedgeMode,
      clientOrderId: `${clientOrderId}_c`,
    })
    if (!close.success) throw new Error(`Close order failed: ${close.error || "unknown error"}`)

    const residual = await waitForPosition(connector, selected.symbol, false)
    if (residual) throw new Error("Test position still exists after close verification")

    const ordersAfter = await connector.getOpenOrders(selected.symbol)
    if (ordersAfter.length > 0) throw new Error("Unexpected open order remains on the isolated test symbol")
    console.log(JSON.stringify({
      phase: "completed",
      success: true,
      symbol: selected.symbol,
      quantity: openedQuantity,
      entryOrderIdPresent: Boolean(entry.orderId),
      closeOrderIdPresent: Boolean(close.orderId),
      residualPosition: false,
      residualOpenOrders: 0,
    }))
  } finally {
    if (entrySucceeded) {
      const residual = await waitForPosition(connector, selected.symbol, true, 2_000)
      if (residual) {
        const residualQty = positionQuantity(residual) || openedQuantity
        const emergencyClose = await connector.placeOrder(selected.symbol, "sell", residualQty, undefined, "market", {
          reduceOnly: true,
          positionSide: mode.hedgeMode ? "LONG" : undefined,
          hedgeMode: mode.hedgeMode,
          clientOrderId: `${clientOrderId}_e`,
        })
        if (!emergencyClose.success) {
          console.error(JSON.stringify({ phase: "emergency-close", success: false, symbol: selected.symbol, error: emergencyClose.error }))
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ phase: "failed", success: false, error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
