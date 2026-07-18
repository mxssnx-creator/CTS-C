/**
 * Data Cleanup Manager
 * Redis-native: Archives and cleans up old data from Redis
 */

import { initRedis, getRedisClient, getSettings, getAppSettings, setSettings } from "@/lib/redis-db"

/**
 * Merge cleanup-related settings from both the `app_settings` (main UI
 * bundle) and `system_settings` (system PATCH route bundle) sources.
 * `app_settings` fields win on conflict. This ensures cleanup toggles
 * saved in either Settings tab apply correctly.
 */
async function loadCleanupSettings(): Promise<Record<string, any>> {
  const [appBundle, systemBundle] = await Promise.all([
    getAppSettings(),
    getSettings("system_settings"),
  ])
  return { ...(systemBundle || {}), ...(appBundle || {}) }
}

export class DataCleanupManager {
  private static instance: DataCleanupManager | null = null
  private cleanupInterval: NodeJS.Timeout | null = null
  private isRunning = false

  private constructor() {}

  public static getInstance(): DataCleanupManager {
    if (!DataCleanupManager.instance) {
      DataCleanupManager.instance = new DataCleanupManager()
    }
    return DataCleanupManager.instance
  }

  public static getOptimalQueryWindow(indicationType: string): number {
    switch (indicationType) {
      case "direction": return 60
      case "move": return 30
      case "optimal": return 120
      case "active_advanced": return 90
      default: return 60
    }
  }

  public async start(): Promise<void> {
    return this.startAutoCleanup()
  }

  public stop(): void {
    this.stopAutoCleanup()
  }

  public stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.isRunning = false
    console.log("[v0] Data cleanup manager stopped")
  }

  public async startAutoCleanup(): Promise<void> {
    console.log("[v0] Starting data cleanup manager...")

    try {
      await initRedis()
      // Merge both settings bundles so the operator's cleanup toggles
      // saved in EITHER the main Settings UI (`app_settings`) or the
      // system PATCH route (`system_settings`) are picked up.
      const settings = await loadCleanupSettings()
      const intervalHours = parseInt(String(settings.cleanupIntervalHours ?? "24"), 10)
      const enabled =
        settings.enableAutoCleanup === true ||
        settings.enableAutoCleanup === "true" ||
        settings.automaticDatabaseCleanup === true ||
        settings.automaticDatabaseCleanup === "true"

      if (!enabled) {
        console.log("[v0] Auto cleanup is disabled in settings")
        return
      }

      this.isRunning = true
      await this.runCleanup()

      this.cleanupInterval = setInterval(async () => {
        await this.runCleanup()
      }, intervalHours * 60 * 60 * 1000)

      console.log(`[v0] Auto cleanup scheduled every ${intervalHours} hour(s)`)
    } catch (error) {
      console.error("[v0] Failed to start auto cleanup:", error)
    }
  }

  private async runCleanup(): Promise<void> {
    console.log("[v0] Running data cleanup...")

    try {
      await initRedis()
      const client = getRedisClient()
      const settings = await loadCleanupSettings()
      const maxPositionAgeDays = parseInt(String(settings.maxPositionAgeDays ?? "90"), 10)
      const maxMarketDataAgeDays = parseInt(String(settings.maxMarketDataDays ?? "30"), 10)

      const now = Date.now()
      const positionCutoff = now - maxPositionAgeDays * 24 * 60 * 60 * 1000
      const marketDataCutoff = now - maxMarketDataAgeDays * 24 * 60 * 60 * 1000

      let archivedPositions = 0
      let cleanedMarketData = 0

      // Clean old closed exchange positions
      const connectionKeys = await client.keys("exchange_positions:*:closed")
      for (const key of connectionKeys) {
        const closedIds = await client.smembers(key)
        for (const posId of closedIds) {
          const pos = await getSettings(`exchange_position:${posId}`)
          if (pos && pos.closed_at && new Date(pos.closed_at).getTime() < positionCutoff) {
            // Archive to a compressed summary
            const archiveKey = `archived_positions:${pos.connection_id}`
            const existing = await getSettings(archiveKey) || { positions: [] }
            existing.positions.push({
              id: pos.id,
              symbol: pos.symbol,
              side: pos.side,
              realized_pnl: pos.realized_pnl,
              closed_at: pos.closed_at,
            })
            await setSettings(archiveKey, existing)

            // Remove full position data
            await client.del(`exchange_position:${posId}`)
            await client.srem(key, posId)
            archivedPositions++
          }
        }
      }

      // Clean old market data (sorted sets with timestamps)
      const marketKeys = await client.keys("market_data:*")
      for (const key of marketKeys) {
        const removed = await client.zremrangebyscore(key, 0, marketDataCutoff)
        if (typeof removed === "number") {
          cleanedMarketData += removed
        }
      }

      // Clean old coordination logs (stored as JSON string arrays via SET, not sorted sets)
      const coordLogKeys = await client.keys("coord_logs:*")
      for (const key of coordLogKeys) {
        try {
          const raw = await client.get(key)
          if (raw) {
            const logs = JSON.parse(raw)
            if (Array.isArray(logs)) {
              const filtered = logs.filter((log: any) => {
                const ts = new Date(log.timestamp || log.created_at || 0).getTime()
                return ts > positionCutoff
              })
              if (filtered.length < logs.length) {
                await client.set(key, JSON.stringify(filtered))
              }
            }
          }
        } catch { /* ignore parse errors - skip this key */ }
      }

      // Clean old volume calculation logs (stored as JSON string arrays via SET, not sorted sets)
      const volumeLogKeys = await client.keys("volume_calcs:*")
      for (const key of volumeLogKeys) {
        try {
          const raw = await client.get(key)
          if (raw) {
            const logs = JSON.parse(raw)
            if (Array.isArray(logs)) {
              const filtered = logs.filter((log: any) => {
                const ts = new Date(log.timestamp || log.created_at || 0).getTime()
                return ts > positionCutoff
              })
              if (filtered.length < logs.length) {
                await client.set(key, JSON.stringify(filtered))
              }
            }
          }
        } catch { /* ignore parse errors - skip this key */ }
      }

      console.log(`[v0] Cleanup complete: archived ${archivedPositions} positions, cleaned ${cleanedMarketData} market data records`)
    } catch (error) {
      console.error("[v0] Error during cleanup:", error)
    }
  }

  public async cleanupHistoricalDataPerExchange(connectionId: string, retentionHours: number): Promise<number> {
    console.log(`[v0] Cleaning up historical data for connection ${connectionId} (retention: ${retentionHours}h)`)

    try {
      await initRedis()
      const client = getRedisClient()
      const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000

      let cleaned = 0

      // Clean market data for this connection
      const marketKey = `market_data:${connectionId}`
      const removed = await client.zremrangebyscore(marketKey, 0, cutoffTime)
      cleaned += typeof removed === "number" ? removed : 0

      // Clean connection-specific symbol market data
      const symbolKeys = await client.keys(`market_data:${connectionId}:*`)
      for (const key of symbolKeys) {
        const r = await client.zremrangebyscore(key, 0, cutoffTime)
        cleaned += typeof r === "number" ? r : 0
      }

      console.log(`[v0] Cleaned up ${cleaned} historical records for connection ${connectionId}`)
      return cleaned
    } catch (error) {
      console.error("[v0] Error during per-exchange cleanup:", error)
      return 0
    }
  }

  public isCleanupRunning(): boolean {
    return this.isRunning
  }
}

export function getDataCleanupManager(): DataCleanupManager {
  return DataCleanupManager.getInstance()
}

export const dataCleanupManager = DataCleanupManager.getInstance()
