"use client"

// Custom hook for real-time price updates
import { useEffect, useState } from "react"
import { useWebSocket } from "./use-websocket"

export interface PriceData {
  symbol: string
  price: number
  change_24h: number
  volume_24h?: number
  last_update: string
}

export function useRealTimePrices(symbols: string[]) {
  const [prices, setPrices] = useState<Map<string, PriceData>>(new Map())
  const wsUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws`
      : "ws://localhost:3001/api/ws"
  const { lastMessage, isConnected } = useWebSocket(wsUrl)

  useEffect(() => {
    if (lastMessage && lastMessage.type === "price_update") {
      const priceUpdate = lastMessage.data
      setPrices((prev) => {
        const newPrices = new Map(prev)
        newPrices.set(priceUpdate.symbol, {
          ...priceUpdate,
          last_update: lastMessage.timestamp,
        })
        return newPrices
      })
    }
  }, [lastMessage])

  // Fallback: Poll API if WebSocket is not connected
  useEffect(() => {
    if (!isConnected) {
      const interval = setInterval(async () => {
        for (const symbol of symbols) {
          try {
            const response = await fetch(`/api/market-data?symbol=${symbol}&limit=1`)
            const data = await response.json()
            if (data.success && data.data.length > 0) {
              const latest = data.data[0]
              setPrices((prev) => {
                const newPrices = new Map(prev)
                newPrices.set(symbol, {
                  symbol,
                  price: latest.close,
                  change_24h: ((latest.close - latest.open) / latest.open) * 100,
                  volume_24h: latest.volume,
                  last_update: latest.timestamp,
                })
                return newPrices
              })
            }
          } catch (error) {
            console.error(`[v0] Error fetching price for ${symbol}:`, error)
          }
        }
      }, 5000)

      return () => clearInterval(interval)
    }
  }, [isConnected, symbols])

  return {
    prices,
    isConnected,
  }
}
