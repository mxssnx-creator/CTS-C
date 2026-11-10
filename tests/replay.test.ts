import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { currentStrategySignal, replayStrategy, type ReplayPosition, type ReplayStrategyConfig } from "../core/replay"
import { POSITION_COST_PCT_DEFAULT } from "../core/metrics"

const START = 1_700_000_000_000
const bars = (prices: number[]) => prices.map((close, i) => ({ close, timestamp: START + i * 60_000 }))
const PRICES = [100,100,100,100,100,99,97,95,93,94,96,99,103,107,111,110,107,103,99,96,93,95,100,106,111,106,99,91,95,101,109]
const config: ReplayStrategyConfig = { type: "MA_Cross", position_cost_step: 3, takeprofit: 0.02, stoploss: 0.02, trailing: false }
const run = (prices = PRICES, overrides: Partial<ReplayStrategyConfig> = {}, cap = 250) =>
  replayStrategy("BTC-USDT", bars(prices), { ...config, ...overrides }, cap) as ReplayPosition[]

describe("causal independent strategy replay", () => {
  test("MA, RSI and MACD have distinct entry timing; Bollinger uses a band recovery", () => {
    const firstEntries = ["MA_Cross", "RSI_Band", "MACD_Signal"].map((type) => run(PRICES, { type })[0].entry_time)
    assert.equal(new Set(firstEntries).size, 3)
    const bouncePrices = [100,100,100,100,100,100,100,100,90,95,100]
    const bounce = run(bouncePrices, { type: "Bollinger_Bounce" })
    assert.equal(bounce.length, 1)
    assert.equal(bounce[0].entry_price, 95)
    assert.equal(bounce[0].direction, "long")
    assert.equal(bounce[0].exit_price, 100)
    assert.equal(run(bouncePrices, { type: "Bollinger_Bounce", position_cost_step: 2 })[0].direction, "long")
    const opposite = run([100,100,100,100,100,100,100,100,110,105,100], { type: "Bollinger_Bounce" })
    assert.equal(opposite[0].direction, "short")
    assert.equal(opposite[0].exit_price, 100)
  })

  test("long and short net outcomes retain losses and charge the cost exactly once", () => {
    const paid = run(PRICES, { roundTripCostPct: 0.2 })
    const free = run(PRICES, { roundTripCostPct: 0 })
    assert.ok(paid.some((p) => p.direction === "long" && (p.result ?? 0) > 0))
    assert.ok(paid.some((p) => p.direction === "short" && (p.result ?? 0) > 0))
    assert.ok(paid.some((p) => (p.result ?? 0) < 0))
    paid.forEach((p, i) => {
      if (p.status === "closed") assert.ok(Math.abs((free[i].result! - p.result!) - 0.2) < 1e-10)
      else assert.equal(p.result, undefined)
    })
    const defaults = run()[0]
    assert.ok(Math.abs((free[0].result! - defaults.result!) - POSITION_COST_PCT_DEFAULT) < 1e-10)
  })

  test("fills are observed closes, including gaps beyond protective stop", () => {
    const trades = run()
    for (const trade of trades) {
      if (trade.status !== "closed") continue
      assert.ok(Date.parse(trade.exit_time!) > Date.parse(trade.entry_time))
      const observed = PRICES[(Date.parse(trade.exit_time!) - START) / 60_000]
      assert.equal(trade.exit_price, observed)
    }
    const loss = trades.find((p) => p.exit_reason === "stop_loss")!
    assert.ok(loss.exit_price! > loss.stop_loss) // short adverse gap fills at 95, not 92.82
  })

  test("trailing ratchets from favorable peak instead of closing at activation TP", () => {
    const prices = PRICES.slice(0, 12).concat([103,107,111,110,107])
    const fixed = run(prices)[0]
    const trail = run(prices, { exitMode: "trailing" })[0]
    assert.equal(fixed.exit_price, 103)
    assert.equal(trail.exit_price, 107)
    assert.equal(trail.exit_reason, "trailing_stop")
    assert.equal(trail.stop_loss, 111 * 0.98)
    assert.ok(trail.stop_loss > trail.entry_price)
  })

  test("short trailing protection tightens from the favorable low", () => {
    const prices = [100,100,100,100,100,101,103,105,107,106,104,101,97,93,89,90,93]
    const trail = run(prices, { exitMode: "trailing" })[0]
    assert.equal(trail.direction, "short")
    assert.equal(trail.entry_price, 101)
    assert.equal(trail.exit_price, 93)
    assert.equal(trail.stop_loss, 89 * 1.02)
    assert.equal(trail.exit_reason, "trailing_stop")
  })

  test("trailing-only starts immediately and always has initial protection", () => {
    const prices = PRICES.slice(0, 12).concat([100,100.5,98])
    const trail = run(prices, { takeprofit: 0.5, exitMode: "trailing-only", stoploss: 0.01 })[0]
    assert.equal(trail.exit_reason, "trailing_stop")
    assert.equal(trail.stop_loss, 100.5 * 0.99)
    assert.equal(trail.exit_price, 98)
    const initial = run(PRICES.slice(0, 12).concat([95]), { exitMode: "trailing", takeprofit: 0.5 })[0]
    assert.equal(initial.exit_reason, "stop_loss")
    assert.equal(initial.exit_price, 95)
  })

  test("future candles cannot change any completed prefix trade", () => {
    for (const type of ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"]) {
      const full = run(PRICES, { type })
      for (let length = 10; length < PRICES.length; length++) {
        const prefix = run(PRICES.slice(0, length), { type }).filter((p) => p.status === "closed")
        const cutoff = START + (length - 1) * 60_000
        assert.deepEqual(prefix, full.filter((p) => p.exit_time && Date.parse(p.exit_time) <= cutoff))
      }
    }
  })

  test("current signal matches replay indicator on each prefix", () => {
    for (const type of ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"]) {
      const full = run(PRICES, { type })
      for (const trade of full) {
        const length = (Date.parse(trade.entry_time) - START) / 60_000 + 1
        assert.equal(currentStrategySignal(bars(PRICES.slice(0, length)), type, 3), trade.direction)
      }
    }
  })

  test("maximum hold and bounded chronological retention work", () => {
    const hold = run(PRICES, { takeprofit: 0.5, stoploss: 0.5, maxHoldMinutes: 2 })
    assert.equal(hold[0].exit_reason, "max_hold")
    assert.equal(Date.parse(hold[0].exit_time!) - Date.parse(hold[0].entry_time), 120_000)
    const full = run()
    assert.deepEqual(run(PRICES, {}, 2), full.slice(-2))
    assert.deepEqual(run(PRICES, {}, 1), full.slice(-1))
  })

  test("invalid input and unsupported tactics cannot turn into synthetic samples", () => {
    assert.deepEqual(run([]), [])
    assert.throws(() => run(PRICES, { type: "unsupported" }), /Unsupported/)
    assert.throws(() => run(PRICES, { roundTripCostPct: -1 }), /cost/)
    assert.throws(() => run([100, Number.NaN]), /observed closes/)
    assert.throws(() => replayStrategy("BTC-USDT", [bars([100])[0], bars([100])[0]], config), /timestamps/)
  })
})
