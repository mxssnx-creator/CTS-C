import { getRedisClient } from "./redis-db"

interface LogEntry {
  timestamp: string
  level: "info" | "warn" | "error"
  category: string
  message: string
  metadata?: Record<string, any>
}

export class SystemLogger {
  static async logToDatabase(entry: LogEntry): Promise<void> {
    try {
      const client = getRedisClient()
      const logId = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
      const logKey = logId

      const logEntry = {
        id: logId,
        timestamp: entry.timestamp,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : "",
      }

      // Store log entry using lowercase hset (pass object directly)
      await client.hset(logKey, logEntry)

      // Use bounded lists (not unbounded sets) for log indexes with automatic trimming
      await client.lpush("logs:all:list", logId)
      await client.ltrim("logs:all:list", 0, 4999) // Keep max 5000 entries
      await client.expire("logs:all:list", 604800) // 7 day TTL

      await client.lpush(`logs:${entry.category}:list`, logId)
      await client.ltrim(`logs:${entry.category}:list`, 0, 999) // Keep max 1000 per category
      await client.expire(`logs:${entry.category}:list`, 604800)

      // Set TTL for individual log entries (7 days = 604800 seconds)
      await client.expire(logKey, 604800)
    } catch (error) {
      console.error("[SystemLogger] Failed to log to database:", error)
    }
  }

  static async logAPI(message: string, level: "info" | "warn" | "error" = "info", endpoint?: string, data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "api",
      message,
      metadata: { endpoint, ...data },
    })
  }

  static async logConnection(message: string, connectionId?: string, level: "info" | "warn" | "error" = "info", data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "connections",
      message,
      metadata: { connectionId, ...data },
    })
  }

  static async logTradeEngine(
    message: string,
    levelOrData?: "info" | "warn" | "error" | Record<string, any>,
    maybeData?: Record<string, any>,
  ): Promise<void> {
    const level = typeof levelOrData === "string" ? levelOrData : "info"
    const metadata = typeof levelOrData === "string" ? maybeData : levelOrData

    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "trade_engine",
      message,
      metadata,
    })
  }

  static async logTrade(message: string, tradeData?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "info",
      category: "trades",
      message,
      metadata: tradeData,
    })
  }

  static async logPosition(message: string, positionData?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "info",
      category: "positions",
      message,
      metadata: positionData,
    })
  }

  static async logError(arg1: any, arg2: any, arg3?: any): Promise<void> {
    const category = typeof arg1 === "string" ? arg1 : typeof arg2 === "string" ? arg2 : "system"
    const error = typeof arg1 === "string" ? arg2 : arg1
    const context = typeof arg1 === "string" ? arg3 : arg3 ?? { source: arg2 }

    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "error",
      category,
      message: error instanceof Error ? error.message : String(error),
      metadata: { ...context, stack: error instanceof Error ? error.stack : undefined },
    })
  }

  static async logToast(message: string, level: "info" | "warn" | "error" = "info", data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "toast",
      message,
      metadata: data,
    })
  }

  static async logWarning(category: string, message: string, data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "warn",
      category,
      message,
      metadata: data,
    })
  }

  static async getLogs(
    category?: string,
    limit: number = 100,
  ): Promise<LogEntry[]> {
    try {
      const client = getRedisClient()
      // Read from bounded lists (new format) with fallback to legacy sets
      const listKey = category ? `logs:${category}:list` : "logs:all:list"
      let logIds = await client.lrange(listKey, 0, limit - 1).catch(() => [] as string[])
      
      // Fallback to legacy set if list is empty (migration period)
      if (!logIds || logIds.length === 0) {
        const setKey = category ? `logs:${category}` : "logs:all"
        logIds = (await client.smembers(setKey).catch(() => [] as string[])).slice(-limit)
      }

      const logs: LogEntry[] = []
      for (const logId of logIds) {
        const logData = await client.hgetall(logId)
        if (logData && Object.keys(logData).length > 0) {
          logs.push({
            timestamp: logData.timestamp || "",
            level: (logData.level as any) || "info",
            category: logData.category || "",
            message: logData.message || "",
            metadata: logData.metadata ? JSON.parse(logData.metadata) : undefined,
          })
        }
      }
      return logs
    } catch (error) {
      console.error("[SystemLogger] Failed to retrieve logs:", error)
      return []
    }
  }

  static async clearLogs(category?: string): Promise<void> {
    try {
      const client = getRedisClient()
      // Clear both list (new) and set (legacy) indexes
      const listKey = category ? `logs:${category}:list` : "logs:all:list"
      const setKey = category ? `logs:${category}` : "logs:all"
      
      // Get IDs from both list and set
      const listIds = await client.lrange(listKey, 0, -1).catch(() => [] as string[])
      const setIds = await client.smembers(setKey).catch(() => [] as string[])
      const allIds = [...new Set([...listIds, ...setIds])]

      for (const logId of allIds) {
        await client.del(logId)
      }

      await client.del(listKey)
      await client.del(setKey)
      console.log(`[SystemLogger] Cleared logs for category: ${category || "all"}`)
    } catch (error) {
      console.error("[SystemLogger] Failed to clear logs:", error)
    }
  }
}
