import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { getVenueMinQty } from "@/lib/exchange-min-qty"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { RateLimiter } from "@/lib/rate-limiter"

describe("progression and live sizing stability", () => {
  test("concurrent operations settle without a deadlock", async () => {
    const result = await Promise.race([
      Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve(index))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ])
    assert.equal(result.length, 20)
  })

  test("known exchange minimum is not inflated by the emergency fallback", () => {
    const result = VolumeCalculator.calculatePositionVolume({
      accountBalance: 10,
      currentPrice: 1,
      leverage: 1,
      positionCost: 0.0002,
      positionsAverage: 2,
      exchangeMinVolume: 2,
      tradeMode: "main",
      mainVolumeFactor: 0.1,
    })
    assert.equal(result.finalVolume, 2)
    assert.equal(result.exchangeMinNotionalUsd, 2)
  })

  test("missing contract metadata uses the guarded five-dollar fallback", () => {
    const result = VolumeCalculator.calculatePositionVolume({
      accountBalance: 10,
      currentPrice: 2,
      leverage: 1,
      positionCost: 0.0002,
      positionsAverage: 2,
      exchangeMinVolume: 0,
      tradeMode: "main",
      mainVolumeFactor: 0.1,
    })
    assert.equal(result.finalVolume, 2.5)
    assert.equal(result.exchangeMinNotionalUsd, 5)
  })

  test("current BingX fallback quantities cover primary verification symbols", () => {
    assert.equal(getVenueMinQty("XRP-USDT"), 2)
    assert.equal(getVenueMinQty("TRXUSDT"), 7)
    assert.equal(getVenueMinQty("DOGE/USDT"), 28)
    assert.equal(getVenueMinQty("SOL_USDT"), 0.03)
  })

  test("null progression data remains safe", () => {
    const symbolCount = (progression: { symbol_count?: string } | null) => progression?.symbol_count ?? "0"
    assert.equal(symbolCount(null), "0")
  })

  test("rate limiter uses its configured concurrency without exceeding it", async () => {
    const limiter = new RateLimiter("unit-concurrency")
    Object.assign(limiter.config, {
      requestsPerSecond: 100,
      requestsPerMinute: 1_000,
      maxConcurrent: 3,
    })
    let active = 0
    let maximumActive = 0
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      limiter.execute(async () => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 50))
        active--
        return index
      })
    ))

    assert.deepEqual(results, [0, 1, 2, 3, 4, 5])
    assert.equal(maximumActive, 3)
  })

  test("rate limiter continues after a rejected request", async () => {
    const limiter = new RateLimiter("unit-rejection")
    Object.assign(limiter.config, {
      requestsPerSecond: 100,
      requestsPerMinute: 1_000,
      maxConcurrent: 2,
    })
    const failed = limiter.execute(async () => { throw new Error("expected") })
    const succeeded = limiter.execute(async () => "continued")
    await assert.rejects(failed, /expected/)
    assert.equal(await succeeded, "continued")
  })
})
