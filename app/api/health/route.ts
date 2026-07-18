import { NextResponse } from "next/server"
import { initRedis, verifyRedisHealth, getAllConnections, getRedisClient, getSettings } from "@/lib/redis-db"
import { healthCheckService } from "@/lib/health-check"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    console.log("[HEALTH] Full health check initiated...")

    // Use new health check service
    const report = await healthCheckService.getHealthReport()

    // Also get legacy metrics for backward compatibility
    const redisHealthy = await verifyRedisHealth()
    if (!redisHealthy) {
      console.error("[HEALTH] Redis health check failed")
      return NextResponse.json({
        ...report,
        status: "degraded",
        redis: "unhealthy",
        message: "Redis connection is not healthy",
      }, { status: 503 })
    }

    console.log("[HEALTH] Redis health check passed")

    // Get all connections from Redis
    const connections = await getAllConnections()
    const enabledConnections = connections.filter(c => c.is_enabled)

    // Get trade engine states
    const client = getRedisClient()
    let runningEngines = 0
    let totalTrades = 0
    let totalPositions = 0

    for (const connection of connections) {
      try {
        const flagKey = `engine_is_running:${connection.id}`
        const flag = await client.get(flagKey)
        const isRunning = flag === "1" || flag === "true"
        if (isRunning) {
          runningEngines++
        }

        const trades = await client.smembers(`trades:${connection.id}`) || []
        const positions = await client.smembers(`positions:${connection.id}`) || []
        totalTrades += trades.length
        totalPositions += positions.length
      } catch (error) {
        console.warn(`[HEALTH] Failed to get metrics for connection ${connection.id}:`, error)
      }
    }

    const status = report.status || (redisHealthy ? "healthy" : "degraded")
    const response = {
      ...report,
      status,
      timestamp: new Date().toISOString(),
      redis: {
        healthy: true,
        connected: true,
      },
      system: {
        totalConnections: connections.length,
        enabledConnections: enabledConnections.length,
        runningEngines: runningEngines,
        totalTrades: totalTrades,
        totalOpenPositions: totalPositions,
      },
    }

    console.log("[HEALTH] Full health check completed successfully")
    
    const statusCode = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 202 : 503
    return NextResponse.json(response, { status: statusCode })
  } catch (error) {
    console.error("[HEALTH] Health check failed:", error)
    return NextResponse.json({
      status: "unhealthy",
      redis: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    }, { status: 503 })
  }
}
