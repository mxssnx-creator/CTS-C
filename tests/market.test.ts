import assert from "node:assert/strict"
import { test } from "node:test"
import { marketSymbol, marketVenue, normalizeCandles, getMarketQuotes } from "../core/market"
test("market identifiers reject paths and unsupported venues", () => {
  assert.equal(marketSymbol("BTC/USDT"), "BTC-USDT")
  assert.throws(() => marketSymbol("../../admin"))
  assert.throws(() => marketVenue("https://localhost"))
})
test("candles preserve OHLC and are unique chronological seconds", () => {
  const candles = normalizeCandles([
    { time: 120000, open: "10", high: "12", low: "9", close: "11", volume: "3" },
    { time: 60000, open: "9", high: "11", low: "8", close: "10", volume: "2" },
    { time: 120000, open: "10", high: "12", low: "9", close: "12", volume: "4" },
  ], "bingx")
  assert.deepEqual(candles.map(c => c.time), [60, 120])
  assert.equal(candles[1].close, 12)
  assert.throws(() => normalizeCandles([{ time: 1000, open: 10, high: 9, low: 8, close: 10, volume: 2 }], "bingx"))
})
test("failed market request produces no synthetic or fixed prices", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 })
  try { await assert.rejects(getMarketQuotes("bingx", ["BTC-USDT"], true), /HTTP 503/) }
  finally { globalThis.fetch = original }
})
test("unsupported venue ticker names do not discard valid quotes or one-character symbols", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: 0, data: [
    { symbol: "S&P500-USDT", price: "6000" },
    { symbol: "BTC-USDT", price: "90000", time: 1700000000000 },
    { symbol: "W-USDT", price: "0.5", time: 1700000000000 },
  ] })
  try {
    const quotes = await getMarketQuotes("bingx", ["BTC-USDT", "W-USDT"], true)
    assert.equal(quotes["BTC-USDT"].price, 90000)
    assert.equal(quotes["W-USDT"].price, 0.5)
  } finally { globalThis.fetch = original }
})
