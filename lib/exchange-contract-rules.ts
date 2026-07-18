import { getVenueMinQty } from "@/lib/exchange-min-qty"

export interface ExchangeMinimumRule {
  quantity: number
  stepSize: number
  quantityPrecision: number
  minNotional: number
  source: string
}

interface BingXContract {
  symbol?: string
  size?: string | number
  quantityPrecision?: string | number
  tradeMinQuantity?: string | number
  tradeMinUSDT?: string | number
  status?: string | number
}

const globalContractCache = globalThis as unknown as {
  __cts_bingx_contract_cache?: { expiresAt: number; contracts: BingXContract[] }
  __cts_bingx_contract_promise?: Promise<BingXContract[]> | null
}

function normalizedSymbol(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function roundUpToStep(value: number, step: number, precision: number): number {
  if (!(step > 0)) return value
  const units = Math.ceil((value - Number.EPSILON) / step)
  return Number((units * step).toFixed(Math.max(0, precision)))
}

async function bingxContracts(): Promise<BingXContract[]> {
  const cached = globalContractCache.__cts_bingx_contract_cache
  if (cached && cached.expiresAt > Date.now()) return cached.contracts
  if (globalContractCache.__cts_bingx_contract_promise) return globalContractCache.__cts_bingx_contract_promise

  globalContractCache.__cts_bingx_contract_promise = (async () => {
    const response = await fetch("https://open-api.bingx.com/openApi/swap/v2/quote/contracts", {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    })
    if (!response.ok) throw new Error(`BingX contract rules returned HTTP ${response.status}`)
    const payload = await response.json() as { code?: string | number; data?: BingXContract[]; msg?: string }
    if (String(payload.code) !== "0" || !Array.isArray(payload.data)) {
      throw new Error(`BingX contract rules failed: ${payload.msg || payload.code}`)
    }
    globalContractCache.__cts_bingx_contract_cache = {
      contracts: payload.data,
      expiresAt: Date.now() + 15 * 60_000,
    }
    return payload.data
  })()

  try {
    return await globalContractCache.__cts_bingx_contract_promise
  } finally {
    globalContractCache.__cts_bingx_contract_promise = null
  }
}

export async function resolveExchangeMinimum(
  exchange: string | undefined,
  symbol: string,
  currentPrice: number,
): Promise<ExchangeMinimumRule> {
  const normalizedExchange = String(exchange || "").toLowerCase()
  if (normalizedExchange === "bingx") {
    const contracts = await bingxContracts()
    const contract = contracts.find((item) =>
      normalizedSymbol(String(item.symbol || "")) === normalizedSymbol(symbol) && Number(item.status) === 1
    )
    if (!contract) throw new Error(`No active BingX contract rule for ${symbol}`)

    const stepSize = Number(contract.size)
    const quantityPrecision = Number(contract.quantityPrecision || 0)
    const minQuantity = Number(contract.tradeMinQuantity || 0)
    const minNotional = Number(contract.tradeMinUSDT || 0)
    const notionalQuantity = currentPrice > 0 && minNotional > 0 ? minNotional / currentPrice : 0
    const quantity = roundUpToStep(Math.max(minQuantity, notionalQuantity), stepSize, quantityPrecision)
    if (!(quantity > 0) || !Number.isFinite(quantity)) throw new Error(`Invalid BingX minimum rule for ${symbol}`)

    return {
      quantity,
      stepSize,
      quantityPrecision,
      minNotional,
      source: "bingx-contracts-v2",
    }
  }

  const quantity = getVenueMinQty(symbol)
  return {
    quantity,
    stepSize: quantity,
    quantityPrecision: 8,
    minNotional: quantity * Math.max(0, currentPrice),
    source: "static-venue-fallback",
  }
}
