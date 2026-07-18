/**
 * Rate Limiter for Exchange API Calls
 * Prevents API rate limit violations with intelligent queuing
 */

interface RateLimitConfig {
  requestsPerSecond: number
  requestsPerMinute: number
  maxConcurrent: number
}

interface QueuedRequest {
  id: string
  execute: () => Promise<any>
  resolve: (value: any) => void
  reject: (error: any) => void
  timestamp: number
}

export class RateLimiter {
  exchange: string
  config: RateLimitConfig
  queue: QueuedRequest[] = []
  processing = false
  requestTimestamps: number[] = []
  activeRequests = 0

  // Exchange-specific rate limits
  static readonly EXCHANGE_LIMITS: Record<string, RateLimitConfig> = {
    bybit: {
      requestsPerSecond: 10,
      requestsPerMinute: 120,
      maxConcurrent: 5,
    },
    bingx: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    },
    binance: {
      requestsPerSecond: 10,
      requestsPerMinute: 1200,
      maxConcurrent: 10,
    },
    okx: {
      requestsPerSecond: 20,
      requestsPerMinute: 600,
      maxConcurrent: 10,
    },
    pionex: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    },
    orangex: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    },
  }

  constructor(exchange: string) {
    this.exchange = exchange.toLowerCase()
    this.config = RateLimiter.EXCHANGE_LIMITS[this.exchange] || {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    }
  }

  async execute<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        id: `${Date.now()}-${Math.random()}`,
        execute: request,
        resolve,
        reject,
        timestamp: Date.now(),
      }

      this.queue.push(queuedRequest)
      this.processQueue()
    })
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return

    this.processing = true

    while (this.queue.length > 0) {
      // Check if we can make a request
      if (!this.canMakeRequest()) {
        await this.sleep(100) // Wait 100ms and check again
        continue
      }

      const request = this.queue.shift()!
      this.activeRequests++

      // Track request timestamp
      const now = Date.now()
      this.requestTimestamps.push(now)

      // Clean old timestamps (older than 1 minute)
      this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60000)

      // Execute the request
      try {
        const result = await request.execute()
        request.resolve(result)
      } catch (error) {
        request.reject(error)
      } finally {
        this.activeRequests--
      }
    }

    this.processing = false
  }

  canMakeRequest(): boolean {
    const now = Date.now()

    // Check concurrent limit
    if (this.activeRequests >= this.config.maxConcurrent) {
      return false
    }

    // Check per-second limit
    const recentTimestamps = this.requestTimestamps.filter((ts) => now - ts < 1000)
    if (recentTimestamps.length >= this.config.requestsPerSecond) {
      return false
    }

    // Check per-minute limit
    const minuteTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60000)
    if (minuteTimestamps.length >= this.config.requestsPerMinute) {
      return false
    }

    return true
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  getStats() {
    const now = Date.now()
    return {
      exchange: this.exchange,
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      requestsLastSecond: this.requestTimestamps.filter((ts) => now - ts < 1000).length,
      requestsLastMinute: this.requestTimestamps.filter((ts) => now - ts < 60000).length,
      config: this.config,
    }
  }
}

// Singleton rate limiters for each exchange
const rateLimiters = new Map<string, RateLimiter>()

export function getRateLimiter(exchange: string): RateLimiter {
  const key = exchange.toLowerCase()
  if (!rateLimiters.has(key)) {
    rateLimiters.set(key, new RateLimiter(key))
  }
  return rateLimiters.get(key)!
}
