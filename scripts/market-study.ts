import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { BingxVstClient, BINGX_VST_HOST, demoCredentials } from "../core/bingx"
import { DEFAULT_ENGINE_SETTINGS, STAGES, TradingEngine } from "../core/engine"
import { generateStrategyCatalog, STRATEGY_RANGES } from "../core/catalog"
import type { Candle, Coordination, LaneState, Stage } from "../core/types"

// Public reads and an optional authenticated commission GET only. This script
// never creates an executor and deliberately cannot submit exchange orders.
const SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "BCH", "DOGE", "ADA", "LTC", "LINK", "AVAX", "TRX", "DOT"].map(s => `${s}-USDT`)
const COORDINATIONS: Coordination[] = ["normal", "axis", "block", "dca"]
const BAR_MS = 60_000, REQUESTED_BARS = 1440
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
function aggregate(lanes: LaneState[], stage: Stage) {
  const required = DEFAULT_ENGINE_SETTINGS.stageLastN[stage === "live" ? "real" : stage]
  const threshold = DEFAULT_ENGINE_SETTINGS.stageMinPF[stage === "live" ? "real" : stage]
  let positive = 0, negative = 0, enoughSamples = 0, qualified = 0
  for (const lane of lanes) {
    positive += lane.grossProfit; negative += lane.grossLoss
    if (lane.samples.length >= required) {
      enoughSamples++
      let wins = 0, losses = 0
      for (const value of lane.samples.slice(0, required)) { wins += Math.max(0, value); losses += Math.max(0, -value) }
      if ((losses > 0 ? wins / losses : wins > 0 ? 999 : 1) >= threshold) qualified++
    }
  }
  return { lanes: lanes.length, entries: lanes.reduce((n, l) => n + l.admissionCount, 0), closed: lanes.reduce((n, l) => n + l.closedCount, 0),
    open: lanes.filter(l => !!l.open).length, retainedSamples: lanes.reduce((n, l) => n + l.samples.length, 0), requiredSamplesPerLane: required,
    enoughSampleLanes: enoughSamples, qualifiedLanes: qualified, profitFactor: negative > 0 ? positive / negative : positive > 0 ? 999 : 1,
    positiveNetReturnPctSum: positive, negativeNetReturnPctSum: negative, modeledNetPnlQuote: lanes.reduce((n, l) => n + l.netPnl, 0) }
}

async function main() {
  const started = Date.now(), publicClient = new BingxVstClient(null, { minRequestIntervalMs: 1100 })
  const output = resolve(option("--output") ?? "docs/market-study.json")
  const endArgument = option("--end")
  const venueNow = await publicClient.clock()
  const requestedEnd = endArgument ? Date.parse(endArgument) : venueNow
  if (!Number.isFinite(requestedEnd) || requestedEnd > venueNow) throw new Error("--end must be a valid non-future ISO timestamp")
  const cutoff = Math.floor(requestedEnd / BAR_MS) * BAR_MS
  const catalog = structuredClone(DEFAULT_ENGINE_SETTINGS.catalog)
  const cost: Record<string, unknown> = { source: "modeled-default", makerFeePct: .05, takerFeePct: .08, slippagePctOfFees: 10, feeQuery: "dedicated-credentials-unavailable" }
  const credentials = demoCredentials()
  if (credentials) {
    try {
      const fee = await new BingxVstClient(credentials).commission("BTC-USDT")
      catalog.makerFeePct = Math.max(0, fee.maker * 100)
      catalog.takerFeePct = fee.taker * 100
      Object.assign(cost, { source: "BTC-USDT-account-commission-plus-modeled-slippage", makerFeePct: catalog.makerFeePct, takerFeePct: catalog.takerFeePct, feeQuery: "succeeded", makerRebateIgnored: fee.maker < 0 })
    } catch (error) { cost.feeQuery = error instanceof Error ? error.message : "Commission read failed" }
  }
  const engine = new TradingEngine({ symbols: SYMBOLS, catalog })
  const feeds: { symbol: string; candles: Candle[] }[] = []
  const datasets: Record<string, unknown>[] = [], failures: { symbol: string; error: string }[] = []
  for (const symbol of SYMBOLS) {
    try {
      const rows = await publicClient.candles(symbol, "1m", REQUESTED_BARS, cutoff - 1)
      let requests = 1
      const uniqueClosed = () => [...new Map(rows.filter(c => c.time + BAR_MS <= cutoff).map(c => [c.time, c])).values()].sort((a, b) => a.time - b.time)
      let unique = uniqueClosed()
      // The venue caps one response at 1,000 rows even for a 1,440 request.
      // Backfill at most two historical pages; stop if an endpoint repeats rows.
      while (unique.length < REQUESTED_BARS && unique.length && requests < 3) {
        const previousLength = unique.length
        rows.push(...await publicClient.candles(symbol, "1m", Math.min(REQUESTED_BARS, REQUESTED_BARS - unique.length + 2), unique[0].time - 1))
        requests++
        unique = uniqueClosed()
        if (unique.length === previousLength) break
      }
      const closed = rows.filter(c => c.time + BAR_MS <= cutoff)
      const duplicateRowsRemoved = closed.length - unique.length
      unique = unique.slice(-REQUESTED_BARS)
      const candles = unique.map(c => ({ timestamp: c.time + BAR_MS, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
      if (!candles.length) throw new Error("No closed observed candles returned")
      const missingMinutes = unique.slice(1).reduce((n, c, i) => n + Math.max(0, Math.round((c.time - unique[i].time) / BAR_MS) - 1), 0)
      datasets.push({ symbol, requested: REQUESTED_BARS, requests, received: rows.length, closed: candles.length, duplicateRowsRemoved,
        fromOpen: new Date(unique[0].time).toISOString(), throughClose: new Date(candles.at(-1)!.timestamp).toISOString(), missingMinutes,
        sha256: createHash("sha256").update(JSON.stringify(unique)).digest("hex") })
      feeds.push({ symbol, candles })
      console.log(JSON.stringify({ event: "public-candles", symbol, closed: candles.length, missingMinutes }))
    } catch (error) { failures.push({ symbol, error: error instanceof Error ? error.message : "Public candle read failed" }) }
  }
  const fetchedAt = Date.now()
  // Global chronological ordering prevents a symbol-by-symbol equity curve
  // from inventing a time order across simultaneous strategies.
  const observations = feeds.flatMap(feed => feed.candles.map(candle => ({ symbol: feed.symbol, candle })))
    .sort((a, b) => a.candle.timestamp - b.candle.timestamp || a.symbol.localeCompare(b.symbol))
  for (const observation of observations) engine.processCandles(observation.symbol, [observation.candle], { allowExecution: false })
  const processedAt = Date.now(), state = engine.exportState(), lanes = Object.values(state.lanes)
  const snapshot = engine.snapshot({ laneLimit: 0, positionLimit: 0 })
  if (state.intents.length) throw new Error("Read-only study unexpectedly generated an execution intent")
  const groups = STAGES.flatMap(stage => STRATEGY_RANGES.flatMap(range => COORDINATIONS.map(coordination => ({ stage, range, coordination,
    ...aggregate(lanes.filter(l => l.stage === stage && l.config.range === range && l.coordination === coordination), stage) }))))
  const result = {
    schemaVersion: 1, kind: "observed-market-read-only-forward-replay", generatedAt: new Date().toISOString(),
    source: { environment: "BingX VST", host: BINGX_VST_HOST, endpoint: "/openApi/swap/v3/quote/klines", interval: "1m", cutoff: new Date(cutoff).toISOString(), symbols: SYMBOLS, requestedBarsPerSymbol: REQUESTED_BARS },
    status: failures.length ? "partial" : datasets.some(d => d.closed !== REQUESTED_BARS || Number(d.missingMinutes) > 0) ? "partial-bars" : "complete",
    datasets, failures, settings: engine.settings, costs: { ...cost, roundTripCostPct: generateStrategyCatalog("bingx-x02", catalog)[0].roundTripCostPct },
    methodology: [
      "All configurations were declared before fetching data; no parameter search, holdout optimization, or result-based filtering.",
      "Only completed, observed public one-minute candles; no generated candles, padding, or synthetic exchange outcomes.",
      "Signals and fills use observed candle closes, timestamped at bar close; OHLC extremes do not imply intrabar executions.",
      "Base, Main, Real and Live are independent paper lanes with fresh positions after each previous-stage qualification; all losses are retained.",
      "All coordination modes are enabled. Block/DCA additions are marked only at observed closes; Axis uses disjoint prior and recent windows.",
      "Profit factor uses sums of positive and negative net percentage returns after one modeled round-trip cost per filled notional; empty/breakeven PF=1, no-loss positive PF is capped at999.",
      "Quote PnL is paper-only and overlapping configuration streams are correlated; this is not a deployed portfolio return or a guarantee of future results.",
      "Account BTC-USDT fee rates, when available, apply uniformly to this study; slippage remains modeled and funding is not included.",
      "Historical warmup has allowExecution=false. No order executor is instantiated and no exchange orders are submitted.",
    ],
    totals: { symbolsProcessed: feeds.length, observedCandles: state.processedCandles, configurationsPerSymbol: snapshot.catalogCount, lanes: lanes.length,
      closed: lanes.reduce((n, l) => n + l.closedCount, 0), open: lanes.filter(l => !!l.open).length, intents: state.intents.length, ordersSubmitted: 0 },
    stages: snapshot.stages,
    byRange: STRATEGY_RANGES.flatMap(range => STAGES.map(stage => ({ range, stage, ...aggregate(lanes.filter(l => l.stage === stage && l.config.range === range), stage) }))),
    byCoordination: COORDINATIONS.flatMap(coordination => STAGES.map(stage => ({ coordination, stage, ...aggregate(lanes.filter(l => l.stage === stage && l.coordination === coordination), stage) }))),
    byRangeCoordinationStage: groups,
    paperLiveEquity: { initial: state.settings.initialEquity, final: state.equity, maxDrawdownPct: state.maxDrawdownPct },
    elapsedMs: { fetch: fetchedAt - started, process: processedAt - fetchedAt, total: Date.now() - started },
    reproduce: `node --env-file=.env.local --import tsx scripts/market-study.ts --end ${new Date(cutoff).toISOString()}`,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify({ event: "study-complete", status: result.status, ...result.totals, elapsedMs: result.elapsedMs, stages: result.stages, output }))
  if (!feeds.length) process.exitCode = 1
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Market study failed"); process.exitCode = 1 })
