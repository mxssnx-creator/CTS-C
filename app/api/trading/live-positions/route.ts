import { NextResponse } from "next/server"
import {
  getLivePositions,
  getClosedLivePositions,
  calculateLivePositionStats,
} from "@/lib/trade-engine/stages/live-stage"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * Returns all live positions for a connection, split into open and closed
 * buckets (via dedicated Redis index lists), plus aggregate stats.
 *
 * Query params:
 *   connection_id  - connection to query (default "bingx-x01")
 *   closedLimit    - max number of closed positions to include (default 200)
 *   status         - optional filter (e.g. "open", "closed", "error")
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const connectionId  = searchParams.get("connection_id") || "bingx-x01"
  const closedLimit   = Math.min(1000, Math.max(1, parseInt(searchParams.get("closedLimit") || "200", 10)))
  const statusFilter  = searchParams.get("status") || undefined

  try {
    await initRedis()

    // Open (active) and closed (archive) come from separate Redis indices so
    // the open scan stays fast even when historical volume is large.
    const [open, closed] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, closedLimit),
    ])

    // Fallback: also scan for any positions stored under alternate key patterns
    const client = getRedisClient()
    const altKeys = await client
      .keys(`live:position:live:${connectionId}:*`)
      .catch(() => [] as string[])
    const altPositions: any[] = []
    const seenIds = new Set<string>([...open.map(p => p.id!).filter(Boolean), ...closed.map(p => p.id!).filter(Boolean)])
    for (const key of altKeys) {
      try {
        const raw = await client.get(key)
        if (raw) {
          const p = JSON.parse(raw)
          if (!seenIds.has(p.id)) {
            altPositions.push(p)
            seenIds.add(p.id)
          }
        }
      } catch { /* skip malformed */ }
    }

    const all = [...open, ...closed, ...altPositions].sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    )

    const filtered = statusFilter
      ? all.filter(p => p.status === statusFilter)
      : all

    // Ensure all positions have calculated/current PnL values
    for (const pos of filtered) {
      if (!pos.unrealizedPnL && pos.status === "open" && pos.exchangeData?.markPrice && pos.averageExecutionPrice && pos.executedQuantity) {
        const markPrice = pos.exchangeData.markPrice
        const entryPrice = pos.averageExecutionPrice || pos.entryPrice || 0
        const qty = pos.executedQuantity || 0
        if (entryPrice > 0 && markPrice > 0 && qty > 0) {
          const pnl = qty * (pos.direction === "long" ? markPrice - entryPrice : entryPrice - markPrice)
          pos.unrealizedPnL = Math.round(pnl * 100) / 100
          
          const lev = Math.max(1, pos.leverage || 1)
          const notional = entryPrice * qty
          const margin = notional > 0 ? notional / lev : 0
          if (margin > 0) {
            pos.unrealizedRoi = Math.round((pos.unrealizedPnL / margin) * 100 * 100) / 100
          }
        }
      }
    }

    const stats = await calculateLivePositionStats(connectionId).catch(() => ({
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    }))

    return NextResponse.json({
      connectionId,
      positions: filtered,
      counts: {
        total:     all.length,
        open:      all.filter(p => p.status === "open").length,
        pending:   all.filter(p => p.status === "pending").length,
        placed:    all.filter(p => p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed").length,
        pending_fill: all.filter(p => p.status === "pending_fill").length,
        filled:    all.filter(p => p.status === "filled").length,
        simulated: all.filter(p => p.status === "simulated").length,
        closed:    all.filter(p => p.status === "closed").length,
        rejected:  all.filter(p => p.status === "rejected").length,
        error:     all.filter(p => p.status === "error").length,
      },
      stats,
    })
  } catch (err) {
    console.warn("[v0] [LivePositions API] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({
      connectionId,
      positions: [],
      counts: { total: 0 },
      stats: null,
    })
  }
}
