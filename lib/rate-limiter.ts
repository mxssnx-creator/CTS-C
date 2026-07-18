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
      // 5/s sustained is 300/min. Keep a 20% safety reserve while avoiding
      // the old 100/min cap that throttled healthy 12-symbol engine baskets.
      requestsPerMinute: 240,
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
    try {
      while (this.queue.length > 0) {
        let launched = false

        // Fill every currently available concurrency slot. The previous
        // implementation awaited each request inside this loop, which made
        // maxConcurrent dead configuration and serialized even independent
        // market-data calls. Requests resolve their own promises out-of-band;
        // the scheduler only controls admission rate and concurrency.
        while (this.queue.length > 0 && this.canMakeRequest()) {
          const request = this.queue.shift()!
          this.activeRequests++
          launched = true

          const now = Date.now()
          this.requestTimestamps.push(now)
          this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60_000)

          void Promise.resolve()
            .then(() => request.execute())
            .then(request.resolve, request.reject)
            .finally(() => {
              this.activeRequests--
              // A request completion may have opened a concurrency slot after
              // the scheduler loop became idle. Safely nudge it again.
              if (this.queue.length > 0) void this.processQueue()
            })
        }

        if (this.queue.length > 0) {
          // Poll quickly enough to fill newly available slots without adding
          // visible latency, while still respecting the one-second window.
          await this.sleep(launched ? 10 : 25)
        }
      }
    } finally {
      this.processing = false
      // Cover the narrow race where a request was enqueued between the final
      // queue check and clearing `processing`.
      if (this.queue.length > 0) void this.processQueue()
    }
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
