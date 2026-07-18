/**
 * Health Check Service
 * 
 * Provides readiness and liveness checks for the system
 * Monitors key dependencies: Redis, database, external APIs
 */

import { getRedisClient, haveMigrationsRun, initRedis } from './redis-db'

export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy'
}

export interface ComponentHealth {
  status: HealthStatus
  responseTime: number
  lastCheck: Date
  error?: string
}

export interface HealthReport {
  status: HealthStatus
  timestamp: Date
  uptime: number
  checks: {
    redis: ComponentHealth
    database: ComponentHealth
    persistence: ComponentHealth
    memory: ComponentHealth
  }
  summary: string
}

export interface ReadinessReport {
  ready: boolean
  timestamp: Date
  components: {
    redis: boolean
    database: boolean
    migrations: boolean
    persistence: boolean
  }
  message: string
}

export class HealthCheckService {
  private startTime = Date.now()
  private lastCheck?: HealthReport

  /**
   * Perform full health check
   */
  async getHealthReport(): Promise<HealthReport> {
    const checks = {
      redis: await this.checkRedis(),
      database: await this.checkDatabase(),
      persistence: await this.checkPersistence(),
      memory: await this.checkMemory()
    }

    // Determine overall status
    const statuses = Object.values(checks).map(c => c.status)
    let status: HealthStatus = HealthStatus.HEALTHY

    if (statuses.includes(HealthStatus.UNHEALTHY)) {
      status = HealthStatus.UNHEALTHY
    } else if (statuses.includes(HealthStatus.DEGRADED)) {
      status = HealthStatus.DEGRADED
    }

    const report: HealthReport = {
      status,
      timestamp: new Date(),
      uptime: Date.now() - this.startTime,
      checks,
      summary: this.generateSummary(checks)
    }

    this.lastCheck = report
    return report
  }

  /**
   * Check Redis connection
   */
  private async checkRedis(): Promise<ComponentHealth> {
    const startTime = Date.now()

    try {
      await initRedis()
      const client = await getRedisClient()
      if (!client) {
        return {
          status: HealthStatus.UNHEALTHY,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: 'Redis client not available'
        }
      }

      // Simple ping to verify connection
      const response = await client.ping()

      if (response !== 'PONG') {
        return {
          status: HealthStatus.UNHEALTHY,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: 'Redis ping failed'
        }
      }

      return {
        status: HealthStatus.HEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date()
      }
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Check database connection
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    const startTime = Date.now()

    try {
      await initRedis()
      const client = await getRedisClient()
      if (!client) {
        return {
          status: HealthStatus.UNHEALTHY,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: 'Database client not available'
        }
      }

      // Try to read a simple key
      await client.get('_health_check_test')

      return {
        status: HealthStatus.HEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date()
      }
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async checkPersistence(): Promise<ComponentHealth> {
    const startTime = Date.now()
    try {
      await initRedis()
      const client = getRedisClient()
      let persistence = client.getPersistenceStatus()
      if (!persistence.lastSuccessfulSaveAt) {
        await client.saveToDisk()
        persistence = client.getPersistenceStatus()
      }
      if (!persistence.lastSuccessfulSaveAt) {
        return {
          status: HealthStatus.UNHEALTHY,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: "Persistent snapshot has never completed successfully",
        }
      }
      const age = Date.now() - persistence.lastSuccessfulSaveAt
      if (age > Math.max(60_000, persistence.intervalMs * 3)) {
        return {
          status: HealthStatus.UNHEALTHY,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: `Persistent snapshot is stale (${age}ms)`,
        }
      }
      const ephemeralPath = persistence.path.startsWith("/tmp/")
      return {
        status: ephemeralPath ? HealthStatus.DEGRADED : HealthStatus.HEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: ephemeralPath ? "Snapshot path is ephemeral; configure a durable mounted path" : undefined,
      }
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Check memory usage
   */
  private async checkMemory(): Promise<ComponentHealth> {
    const startTime = Date.now()

    try {
      const memUsage = process.memoryUsage()
      const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100

      let status = HealthStatus.HEALTHY

      // Warn if heap usage is above 80%
      if (heapUsedPercent > 90) {
        status = HealthStatus.UNHEALTHY
      } else if (heapUsedPercent > 80) {
        status = HealthStatus.DEGRADED
      }

      return {
        status,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: status !== HealthStatus.HEALTHY 
          ? `High memory usage: ${heapUsedPercent.toFixed(1)}%`
          : undefined
      }
    } catch (error) {
      return {
        status: HealthStatus.DEGRADED,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(checks: { [key: string]: ComponentHealth }): string {
    const healthy = Object.values(checks).filter(c => c.status === HealthStatus.HEALTHY).length
    const total = Object.keys(checks).length

    return `${healthy}/${total} components healthy`
  }

  /**
   * Get readiness status
   * System is ready when it can handle requests
   */
  async getReadinessStatus(): Promise<ReadinessReport> {
    const health = await this.getHealthReport()
    const migrations = haveMigrationsRun()
    const persistence = health.checks.persistence.status !== HealthStatus.UNHEALTHY
    const ready = health.status !== HealthStatus.UNHEALTHY && migrations && persistence

    return {
      ready,
      timestamp: new Date(),
      components: {
        redis: health.checks.redis.status !== HealthStatus.UNHEALTHY,
        database: health.checks.database.status !== HealthStatus.UNHEALTHY,
        migrations,
        persistence,
      },
      message: ready
        ? 'System is ready to handle requests'
        : `System is not ready: ${health.summary}`
    }
  }

  /**
   * Get liveness status
   * System is alive if it's still running and responsive
   */
  async getLivenessStatus(): Promise<{
    alive: boolean
    uptime: number
    timestamp: Date
  }> {
    return {
      alive: true,
      uptime: Date.now() - this.startTime,
      timestamp: new Date()
    }
  }

  /**
   * Get last health check
   */
  getLastHealthCheck(): HealthReport | undefined {
    return this.lastCheck
  }

  /**
   * Get system stats for monitoring
   */
  getSystemStats(): {
    uptime: number
    memory: NodeJS.MemoryUsage
    cpu: NodeJS.CpuUsage
    eventLoop: number
  } {
    return {
      uptime: Date.now() - this.startTime,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      eventLoop: 0 // Would measure event loop lag here
    }
  }
}

// Export singleton instance
export const healthCheckService = new HealthCheckService()

export default HealthCheckService
