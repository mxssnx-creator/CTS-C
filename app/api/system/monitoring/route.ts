import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    const memUsage = process.memoryUsage()
    const os = await import('os')
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times]
      }
      totalIdle += cpu.times.idle
    })
    const cpuPercent = Math.round(100 - (totalIdle / totalTick * 100))
    const memPercent = memUsage.heapTotal > 0
      ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
      : 0

    let allKeys: string[] = []
    let redisAvailable = false
    try {
      const keysResult = await client.keys("*")
      allKeys = Array.isArray(keysResult) ? keysResult : []
      redisAvailable = true
    } catch {
      allKeys = []
      redisAvailable = false
    }
    
    const keys = allKeys.length
    const sets = allKeys.filter((k: string) => k.includes(":set") || k.includes("_set")).length
    const positionKeys = allKeys.filter((k: string) => k.includes("position")).length
    const indicationKeys = allKeys.filter((k: string) => 
      k.includes("indication") || k.includes("indications:") || k.includes(":rsi") || k.includes(":macd")
    ).length
    const strategyKeys = allKeys.filter((k: string) => 
      k.includes("strategy") || k.includes("strategies:") || k.includes("entry:") || k.includes("signal:")
    ).length

    let estimatedDbBytes = 0
    try {
      const sampleKeys = allKeys.slice(0, 20)
      let sampledBytes = 0
      for (const key of sampleKeys) {
        sampledBytes += key.length
        const strValue = await client.get(key).catch(() => null)
        if (typeof strValue === "string" && strValue.length > 0) {
          sampledBytes += strValue.length
          continue
        }
        const hashValue = await client.hgetall(key).catch(() => null)
        if (hashValue && typeof hashValue === "object") {
          for (const [field, value] of Object.entries(hashValue)) {
            sampledBytes += String(field).length + String(value).length
          }
        }
      }
      estimatedDbBytes = sampleKeys.length > 0
        ? Math.max(0, Math.round((sampledBytes / sampleKeys.length) * Math.max(keys, 1)))
        : 0
    } catch {
      estimatedDbBytes = 0
    }

    let coordinatorEngineCount = 0
    try {
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      coordinatorEngineCount = coordinator?.getActiveEngineCount?.() ?? 0
    } catch {
      coordinatorEngineCount = 0
    }
    
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let indicationsRunning = false
    let strategiesRunning = false
    let redisActiveEngineCount = 0
    
    // PRIMARY: read live progression hashes (written every cycle — always current)
    try {
      const progressionKeys = allKeys.filter((k: string) => k.startsWith("progression:") && !k.includes(":"))
      for (const progKey of progressionKeys) {
        try {
          const progHash = await client.hgetall(progKey)
          if (progHash && typeof progHash === "object") {
            const indCycles  = Number(progHash.indication_cycle_count)  || 0
            const stratCycles = Number(progHash.strategy_cycle_count)   || 0
            if (indCycles > 0 || stratCycles > 0) {
              totalIndicationCycles += indCycles
              totalStrategyCycles   += stratCycles
              indicationsRunning     = true
              strategiesRunning      = true
              redisActiveEngineCount++
            }
          }
        } catch {}
      }
    } catch {}

    // FALLBACK: settings:trade_engine_state:* keys (stale — every 50-100 cycles)
    // Only used when live progression hash is empty (engine just started)
    if (totalIndicationCycles === 0) {
      try {
        const connectionStateKeys = allKeys.filter((k: string) => k.startsWith("settings:trade_engine_state:"))
        for (const stateKey of connectionStateKeys) {
          try {
            const stateStr = await client.get(stateKey)
            if (stateStr) {
              const state = JSON.parse(stateStr)
              totalIndicationCycles += Number(state.indication_cycle_count) || 0
              totalStrategyCycles   += Number(state.strategy_cycle_count)   || 0
              if (state.status === "running") {
                indicationsRunning     = true
                strategiesRunning      = true
                redisActiveEngineCount++
              }
            }
          } catch {}
        }
      } catch {}
    }
    
    let redisEngineRunning = false
    try {
      const globalEngine = await client.hgetall("trade_engine:global")
      if (globalEngine && Object.keys(globalEngine).length > 0) {
        redisEngineRunning = globalEngine.status === "running"
      }
    } catch {}
    
    const engineRunning = redisEngineRunning || indicationsRunning || strategiesRunning || coordinatorEngineCount > 0
    const activeEngineCount = Math.max(coordinatorEngineCount, redisActiveEngineCount)
    const indicationsEngineRunning = indicationsRunning || (engineRunning && activeEngineCount > 0)
    const strategiesEngineRunning = strategiesRunning || (engineRunning && activeEngineCount > 0)

    let requestsPerSecond = 0
    try {
      const { getRedisRequestsPerSecond } = await import("@/lib/redis-db")
      requestsPerSecond = getRedisRequestsPerSecond()
    } catch {
      requestsPerSecond = 0
    }

    return NextResponse.json({
      cpu: cpuPercent,
      memory: memPercent,
      memoryUsed: Math.round(memUsage.heapUsed / 1024),
      memoryTotal: Math.round(memUsage.heapTotal / 1024),
      database: {
        size: estimatedDbBytes,
        keys,
        sets,
        positions1h: positionKeys,
        entries1h: indicationKeys + strategyKeys,
        requestsPerSecond: Math.max(0, requestsPerSecond),
      },
      services: {
        tradeEngine: engineRunning,
        indicationsEngine: indicationsEngineRunning,
        strategiesEngine: strategiesEngineRunning,
        websocket: redisAvailable,
      },
      modules: {
        redis: redisAvailable,
        persistence: keys > 0,
        coordinator: engineRunning || coordinatorEngineCount > 0,
        logger: true,
      },
      engines: {
        indications: {
          running: indicationsEngineRunning,
          cycleCount: totalIndicationCycles,
          resultsCount: indicationKeys,
        },
        strategies: {
          running: strategiesEngineRunning,
          cycleCount: totalStrategyCycles,
          resultsCount: strategyKeys,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[Monitoring] Error:", error)
    return NextResponse.json(
      { 
        cpu: 0, 
        memory: 0, 
        memoryUsed: 0, 
        memoryTotal: 1,
        database: { size: 0, keys: 0, sets: 0, positions1h: 0, entries1h: 0, requestsPerSecond: 0 },
        services: { tradeEngine: false, indicationsEngine: false, strategiesEngine: false, websocket: false },
        modules: { redis: false, persistence: false, coordinator: false, logger: true },
        engines: {
          indications: { running: false, cycleCount: 0, resultsCount: 0 },
          strategies: { running: false, cycleCount: 0, resultsCount: 0 },
        },
        error: "Failed to fetch metrics", 
        details: error instanceof Error ? error.message : "Unknown" 
      },
      { status: 200 }
    )
  }
}
