import { BaseExchangeConnector, type ExchangeCredentials } from "./base-connector";
import { v4 as uuidv4 } from "uuid";

// Minimal simulated connector used for tests when external exchange calls are blocked.
// It fakes immediate fills and basic position responses so the live pipeline exercises
// order placement, SL/TP placement, and reconcile paths without network access.

export class SimulatedConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "simulated") {
    super(credentials, exchange)
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage"]
  }

  async testConnection(): Promise<any> {
    return { success: true, balance: 1000, capabilities: this.getCapabilities(), logs: [] }
  }

  async getBalance(): Promise<any> {
    return { success: true, balance: 1000, balances: [{ asset: "USDT", free: 1000, locked: 0, total: 1000 }] }
  }

  async placeOrder(symbol: string, side: "buy" | "sell", quantity: number): Promise<{ success: boolean; orderId?: string; filledQty?: number; filledPrice?: number; error?: string }> {
    const orderId = `sim-${Date.now()}-${Math.floor(Math.random() * 100000)}`
    // Simulate immediate full fill at a synthetic price
    const filledPrice = 1.0
    return { success: true, orderId, filledQty: quantity, filledPrice }
  }

  async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: any = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    const id = `sim-stop-${Date.now()}`
    return { success: true, orderId: id }
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    return { success: true, orderId, status: "filled", filledQty: 0, avgPrice: 0 }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    return []
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    return []
  }

  async getPosition(symbol: string): Promise<any> {
    return { symbol, side: "long", contracts: 0, entryPrice: 0, currentPrice: 0, markPrice: 0, leverage: 1, marginType: "cross", unrealizedPnl: 0, realizedPnl: 0, liquidationPrice: 0, timestamp: Date.now() }
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async modifyPosition(symbol: string, leverage?: number, marginType?: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean }> {
    return { success: true }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    return { address: `sim-address-${coin}` }
  }

  async withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }> {
    return { success: true, txId: `sim-tx-${Date.now()}` }
  }

  async getTransferHistory(limit: number = 20): Promise<Array<{ type: string; coin: string; amount: number; timestamp: number }>> {
    return []
  }

  async setLeverage(_symbol: string, _lev: number): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async setMarginType(_symbol: string, _type: string): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async setPositionMode(_hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    return { bid: 1, ask: 1.1, last: 1 }
  }

  async getOHLCV(symbol: string, timeframe: string = "1m", limit: number = 100): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null> {
    return []
  }
}
