import { NextResponse } from "next/server"
import { loadConnections } from "@/lib/file-storage"
import { SystemLogger } from "@/lib/system-logger"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Fetching detailed trading statistics")
    
    const connections = loadConnections()
    const enabledConnections = connections.filter((c) => c.is_enabled && c.is_live_trade)
    
    // Return comprehensive stats with last250, last50, and last32h
    try {
      // Get last 250 positions
      const last250 = await query(
        `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
          COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 0) as winRate,
          COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END), 0), 0) as profitFactor,
          COALESCE(SUM(pnl), 0) as totalProfit
         FROM pseudo_positions ORDER BY created_at DESC LIMIT 250`
      )
      
      // Get last 50 positions
      const last50 = await query(
        `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
          COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 0) as winRate,
          COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END), 0), 0) as profitFactor,
          COALESCE(SUM(pnl), 0) as totalProfit
         FROM pseudo_positions ORDER BY created_at DESC LIMIT 50`
      )
      
      // Get last 32 hours
      const last32h = await query(
        `SELECT 
          COUNT(*) as total,
          COALESCE(SUM(pnl), 0) as totalProfit,
          COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END), 0), 0) as profitFactor
         FROM pseudo_positions WHERE created_at >= datetime('now', '-32 hours')`
      )
      
      const l250 = (last250 as any[])[0]
      const l50 = (last50 as any[])[0]
      const l32 = (last32h as any[])[0]
      
      console.log(`[v0] Trading stats - Last250: ${l250?.total || 0}, Last50: ${l50?.total || 0}, Last32h: ${l32?.total || 0}`)
      
      return NextResponse.json({
        last250: {
          total: l250?.total || 0,
          wins: l250?.wins || 0,
          losses: l250?.losses || 0,
          winRate: l250?.winRate || 0,
          profitFactor: l250?.profitFactor || 0,
          totalProfit: l250?.totalProfit || 0,
        },
        last50: {
          total: l50?.total || 0,
          wins: l50?.wins || 0,
          losses: l50?.losses || 0,
          winRate: l50?.winRate || 0,
          profitFactor: l50?.profitFactor || 0,
          totalProfit: l50?.totalProfit || 0,
        },
        last32h: {
          total: l32?.total || 0,
          totalProfit: l32?.totalProfit || 0,
          profitFactor: l32?.profitFactor || 0,
        },
      })
    } catch (dbError) {
      console.warn("[v0] Database stats not available:", dbError)
      return NextResponse.json({
        last250: { total: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalProfit: 0 },
        last50: { total: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalProfit: 0 },
        last32h: { total: 0, totalProfit: 0, profitFactor: 0 },
      })
    }
  } catch (error) {
    console.error("[v0] Failed to fetch stats:", error)
    await SystemLogger.logError(error, "api", "GET /api/trading/stats")
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 })
  }
}
