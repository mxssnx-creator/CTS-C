import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Fetching aggregated exchange-positions statistics")
    
    await initRedis()
    const connections = await getAllConnections()
    const activeConnections = connections.filter(c => 
      (c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true || c.is_enabled_dashboard === "true") &&
      (c.is_enabled === "1" || c.is_enabled === true || c.is_enabled === "true")
    )

    if (activeConnections.length === 0) {
      return NextResponse.json({
        symbols: []
      })
    }

    // For now, return mock symbols until we have real data aggregation
    // In production, this would aggregate from redis position data
    const symbols = [
      { symbol: "BTC/USDT", livePositions: 2, openPositions: 2, profitFactor250: 1.45, profitFactor50: 1.32 },
      { symbol: "ETH/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.28, profitFactor50: 1.15 },
      { symbol: "BNB/USDT", livePositions: 0, openPositions: 0, profitFactor250: 0.92, profitFactor50: 0.88 },
      { symbol: "XRP/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.52, profitFactor50: 1.68 },
      { symbol: "ADA/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.1, profitFactor50: 0.95 },
      { symbol: "DOGE/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.35, profitFactor50: 1.22 },
      { symbol: "SOL/USDT", livePositions: 2, openPositions: 2, profitFactor250: 1.62, profitFactor50: 1.45 },
      { symbol: "LINK/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.18, profitFactor50: 1.05 },
      { symbol: "LTC/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.42, profitFactor50: 1.38 },
      { symbol: "AVAX/USDT", livePositions: 0, openPositions: 0, profitFactor250: 0.98, profitFactor50: 0.92 },
      { symbol: "ARB/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.55, profitFactor50: 1.48 },
      { symbol: "OP/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.22, profitFactor50: 1.12 },
      { symbol: "MATIC/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.38, profitFactor50: 1.25 },
      { symbol: "APE/USDT", livePositions: 0, openPositions: 0, profitFactor250: 0.88, profitFactor50: 0.82 },
      { symbol: "FTM/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.31, profitFactor50: 1.28 },
      { symbol: "NEAR/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.44, profitFactor50: 1.39 },
      { symbol: "ATOM/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.25, profitFactor50: 1.18 },
      { symbol: "CRO/USDT", livePositions: 0, openPositions: 0, profitFactor250: 0.95, profitFactor50: 0.91 },
      { symbol: "PEPE/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.58, profitFactor50: 1.52 },
      { symbol: "INJ/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.36, profitFactor50: 1.29 },
      { symbol: "BLUR/USDT", livePositions: 1, openPositions: 1, profitFactor250: 1.19, profitFactor50: 1.1 },
      { symbol: "SEI/USDT", livePositions: 0, openPositions: 0, profitFactor250: 1.41, profitFactor50: 1.35 },
    ]

    return NextResponse.json({
      symbols: symbols.slice(0, 22) // Return max 22 symbols as requested
    })
  } catch (error) {
    console.error("[v0] Failed to fetch exchange-positions statistics:", error)
    return NextResponse.json({
      symbols: []
    })
  }
}
