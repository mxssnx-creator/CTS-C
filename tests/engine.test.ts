import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine, DEFAULT_ENGINE_SETTINGS, validateEngineSettings } from "../core/engine"
import { generateStrategyCatalog } from "../core/catalog"
import type { Candle, EngineSettings } from "../core/types"

const baseTime = 1_790_000_000_000
function candles(count: number, start = 0, scale = 1): Candle[] {
  return Array.from({ length: count }, (_, j) => {
    const i = start + j, close = scale * (100 + 10 * Math.sin(i / 5) + 2 * Math.sin(i / 13))
    return { timestamp: baseTime + i * 60_000, open: close, high: close, low: close, close, volume: 100 }
  })
}
function settings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return validateEngineSettings({ ...structuredClone(DEFAULT_ENGINE_SETTINGS), symbols: ["BTC-USDT"], stageLastN: { base: 2, main: 2, real: 2 }, stageMinPF: { base: 0, main: 0, real: 0 },
    coordinations: { axis: { enabled: false, previous: 2, last: 1, outcome: "any" }, block: { enabled: false, steps: 2, ratio: .2, mode: "shared" }, dca: { enabled: false, steps: 2, distancePct: .5, multiplier: 2 } },
    catalog: { strategyTpSteps: [3], strategySlRatios: [1], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] }, ...overrides })
}
const bar = (timestamp: number, price: number): Candle => ({ timestamp, open: price, close: price, high: price, low: price, volume: 100 })

test("default catalog covers all 3696 independent configurations and full tactics", () => {
  const catalog = generateStrategyCatalog("bingx-x02")
  assert.equal(catalog.length, 3696)
  assert.equal(new Set(catalog.map(c => c.id)).size, 3696)
  for (const range of ["Micro", "Minimal", "Short", "Normal", "Long", "Wide"]) assert.ok(catalog.some(c => c.range === range))
  for (const type of ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"]) assert.ok(catalog.some(c => c.type === type))
})

test("each stage starts fresh and learns only after its parent's causal qualification", () => {
  const engine = new TradingEngine(settings())
  const first = new Map<string, number>()
  for (const candle of candles(600)) {
    const events = engine.processCandles("BTCUSDT", [candle])
    for (const event of events) if (event.type === "opened" && !first.has(event.stage)) {
      first.set(event.stage, event.timestamp)
      const state = engine.exportState()
      assert.equal(state.lanes[event.laneId].samples.length, 0)
      if (event.stage !== "base") assert.ok(state.lanes[event.laneId].admittedAt! > first.get("base")!)
    }
  }
  assert.deepEqual([...first.keys()], ["base", "main", "real", "live"])
  assert.ok(first.get("base")! < first.get("main")! && first.get("main")! < first.get("real")! && first.get("real")! < first.get("live")!)
  const snapshot = engine.snapshot()
  assert.ok(snapshot.stages.every(s => s.closed > 0))
  assert.ok(snapshot.stages.every(s => s.enoughSamplesPct >= 0 && s.enoughSamplesPct <= 100))
  assert.equal(snapshot.intents.length, 0, "prewarm cannot send execution intents")
})

test("incremental processing, duplicate delivery, and JSON restart preserve exact outcomes", () => {
  const all = candles(650), cfg = settings(), whole = new TradingEngine(cfg), split = new TradingEngine(cfg)
  whole.processCandles("BTC-USDT", all)
  split.processCandles("BTC-USDT", all.slice(0, 337))
  const restored = new TradingEngine(cfg, JSON.parse(JSON.stringify(split.exportState())))
  restored.processCandles("BTC-USDT", all.slice(300))
  const outcome = (e: TradingEngine) => ({ trades: e.snapshot().trades, stages: e.snapshot().stages, signals: e.exportState().signals, equity: e.snapshot().equity, lanes: e.snapshot().lanes })
  assert.deepEqual(outcome(restored), outcome(whole))
  const before = restored.snapshot()
  assert.deepEqual(restored.processCandles("BTC-USDT", all), [])
  assert.equal(restored.snapshot().processedCandles, before.processedCandles)
  assert.equal(restored.snapshot().stages[0].closed, before.stages[0].closed)
})

test("future candles cannot alter already realized trades and invalid marks never enter the ledger", () => {
  const engine = new TradingEngine(settings()), prefix = candles(350)
  engine.processCandles("BTC-USDT", prefix)
  const before = engine.snapshot().trades.map(t => ({ id: t.id, netPnl: t.netPnl }))
  engine.processCandles("BTC-USDT", candles(30, 350))
  for (const trade of before) assert.equal(engine.snapshot().trades.find(t => t.id === trade.id)?.netPnl, trade.netPnl)
  assert.throws(() => engine.processCandles("BTC-USDT", [bar(baseTime + 400 * 60_000, NaN)]))
  assert.throws(() => engine.processCandles("BTC-USDT", [bar(baseTime + 401 * 60_000, 100), bar(baseTime + 400 * 60_000, 101)]))
})

test("symbol, direction and configuration losses cannot close or contaminate another lane", () => {
  const engine = new TradingEngine(settings({ symbols: ["BTC-USDT", "ETH-USDT"], catalog: { strategyTpSteps: [3, 4], strategySlRatios: [1], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] } }))
  engine.processCandles("BTC-USDT", candles(300))
  const before = engine.exportState()
  engine.processCandles("ETH-USDT", candles(300, 0, 20))
  const after = engine.exportState()
  for (const [id, lane] of Object.entries(before.lanes)) assert.deepEqual(after.lanes[id], lane)
  const btc = engine.snapshot().lanes.filter(l => l.symbol === "BTC-USDT")
  assert.ok(btc.some(l => l.direction === "long") && btc.some(l => l.direction === "short"))
  assert.equal(new Set(btc.filter(l => l.stage === "base").map(l => l.configId)).size, 2)
})

test("DCA creates priced fills, updates weighted entry, and charges costs only once on total notional", () => {
  const cfg = settings({ catalog: { strategyTpSteps: [30], strategySlRatios: [2.2], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] } })
  cfg.coordinations.dca.enabled = true
  const engine = new TradingEngine(cfg)
  let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined
  let index = 0
  for (; index < 150; index++) {
    engine.processCandles("BTC-USDT", candles(1, index))
    position = engine.snapshot().positions.find(p => p.stage === "base" && p.coordination === "dca")
    if (position) break
  }
  assert.ok(position)
  const sign = position.direction === "long" ? 1 : -1
  const adverse = position.entryPrice * (1 - sign * .006)
  engine.processCandles("BTC-USDT", [bar(baseTime + (++index) * 60_000, adverse)])
  const added = engine.snapshot().positions.find(p => p.id === position!.id)!
  assert.equal(added.fills.length, 2)
  assert.equal(added.fills[1].kind, "dca")
  assert.ok(Math.abs(added.entryPrice - added.notional / added.quantity) < 1e-12)
  const exit = added.entryPrice * (1 + sign * .15)
  engine.processCandles("BTC-USDT", [bar(baseTime + (++index) * 60_000, exit)])
  const trade = engine.snapshot().trades.find(t => t.id === position!.id)!
  assert.ok(trade)
  assert.ok(Math.abs(trade.cost - trade.notional * added.costPct / 100) < 1e-12)
  assert.ok(Math.abs(trade.netPnl - (trade.grossPnl - trade.cost)) < 1e-12)
})

test("shared Block distributes its fixed notional budget and additive Block increases it", () => {
  for (const mode of ["shared", "additive"] as const) {
    const cfg = settings({ catalog: { strategyTpSteps: [30], strategySlRatios: [2.2], strategyExitModes: ["trailing-only"], strategyIndicationTypes: ["MA_Cross"] } })
    cfg.coordinations.block = { enabled: true, steps: 2, ratio: .5, mode }
    const engine = new TradingEngine(cfg)
    let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined, index = 0
    for (; index < 150; index++) { engine.processCandles("BTC-USDT", candles(1, index)); position = engine.snapshot().positions.find(p => p.stage === "base" && p.coordination === "block"); if (position) break }
    assert.ok(position)
    const sign = position.direction === "long" ? 1 : -1
    for (let i = 1; i <= 2; i++) engine.processCandles("BTC-USDT", [bar(baseTime + (++index) * 60_000, position.entryPrice * (1 + sign * .025 * i))])
    const added = engine.snapshot().positions.find(p => p.id === position!.id)!
    assert.equal(added.fills.length, 3)
    const expected = cfg.baseNotional * cfg.volumeFactor * (mode === "shared" ? 1 : 2)
    assert.ok(Math.abs(added.notional - expected) < 1e-10)
  }
})

test("execution intents follow owned entry and close, persist IDs, and acknowledgements are idempotent", () => {
  const cfg = settings({ stageLastN: { base: 1, main: 1, real: 1 } }), engine = new TradingEngine(cfg)
  engine.processCandles("BTC-USDT", candles(500), { allowExecution: true })
  const intents = engine.pendingIntents()
  assert.ok(intents.some(i => i.kind === "entry"))
  assert.ok(intents.some(i => i.kind === "close"))
  for (const close of intents.filter(i => i.kind === "close")) assert.ok(intents.some(i => i.kind === "entry" && i.positionId === close.positionId))
  assert.equal(new Set(intents.map(i => i.id)).size, intents.length)
  const first = intents[0]
  engine.markExecution(first.id, { status: "acknowledged", exchangeOrderId: "1" })
  engine.markExecution(first.id, { status: "rejected", error: "late duplicate" })
  assert.equal(engine.snapshot().intents[0].status, "acknowledged")
  const restored = new TradingEngine(cfg, engine.exportState())
  assert.deepEqual(restored.pendingIntents(), engine.pendingIntents())
})

test("100-symbol incremental workload remains bounded and independent (deterministic offline fixture)", () => {
  const symbols = Array.from({length: 100}, (_, i) => `S${i}-USDT`)
  const engine = new TradingEngine(settings({ symbols, maxSamples: 20 }))
  const start = performance.now()
  for (const symbol of symbols) engine.processCandles(symbol, candles(300))
  const elapsedMs = performance.now() - start, state = engine.exportState()
  assert.equal(state.processedCandles, 30_000)
  assert.equal(Object.keys(state.lastTimestamp).length, 100)
  assert.ok(Object.values(state.lanes).every(l => l.samples.length <= 20))
  assert.ok(state.recentTrades.length <= 1000 && state.equityHistory.length <= 1000)
  assert.ok(elapsedMs < 30_000, `Fixture exceeded 30s: ${elapsedMs.toFixed(0)}ms`)
  console.log(JSON.stringify({ fixture: "100 symbols × 300 synthetic deterministic bars, one config", elapsedMs: Math.round(elapsedMs), lanes: Object.keys(state.lanes).length, bytes: JSON.stringify(state).length }))
})

test("quote ticks manage stops once between bars without generating signals or changing bar cursor", () => {
  const engine = new TradingEngine(settings())
  let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined
  for (let i = 0; i < 100; i++) { engine.processCandles("BTC-USDT", candles(1, i)); position = engine.snapshot().positions[0]; if (position) break }
  assert.ok(position)
  const before = engine.exportState(), direction = position.direction === "long" ? 1 : -1
  const events = engine.processTick("BTC-USDT", position.entryPrice * (1 + direction * .01), position.openedAt + 1000)
  assert.ok(events.some(e => e.type === "closed" && e.laneId === position!.laneId))
  assert.deepEqual(engine.processTick("BTC-USDT", position.entryPrice * (1 + direction * .01), position.openedAt + 1000), [])
  assert.equal(engine.exportState().processedCandles, before.processedCandles)
  assert.deepEqual(engine.exportState().lastTimestamp, before.lastTimestamp)
  assert.ok(events.every(e => e.type !== "opened"))
})

test("economic catalog identity changes with cost and never borrows a prior configuration's samples", () => {
  const cfg = settings(), engine = new TradingEngine(cfg)
  engine.processCandles("BTC-USDT", candles(300))
  const old = engine.exportState(), oldIds = new Set(Object.values(old.lanes).map(l => l.configId))
  const oldConfig = generateStrategyCatalog(cfg.connectionId, cfg.catalog, "2020-01-01")[0]
  const stable = generateStrategyCatalog(cfg.connectionId, cfg.catalog, "2030-01-01")[0]
  assert.equal(oldConfig.id, stable.id, "wall-clock creation time is not an economic parameter")
  engine.updateSettings({ catalog: { ...cfg.catalog, takerFeePct: .1 } })
  let newLaneSeen = false
  for (const candle of candles(100, 300)) {
    const events = engine.processCandles("BTC-USDT", [candle]), state = engine.exportState()
    for (const event of events.filter(e => e.type === "opened")) {
      const lane = state.lanes[event.laneId]
      if (!oldIds.has(lane.configId) && !newLaneSeen) {
        newLaneSeen = true
        assert.equal(lane.stage, "base")
        assert.equal(lane.samples.length, 0)
      }
    }
  }
  assert.ok(newLaneSeen)
  assert.notEqual(generateStrategyCatalog(cfg.connectionId, engine.settings.catalog)[0].id, oldConfig.id)
  assert.throws(() => engine.updateSettings({ connectionId: "another-account" }))
})

test("changing DCA terms creates an independent lane while existing fills retain their original budget", () => {
  const cfg = settings({ catalog: { strategyTpSteps: [30], strategySlRatios: [2.2], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] } })
  cfg.coordinations.dca.enabled = true
  const engine = new TradingEngine(cfg)
  let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined, index = 0
  for (; index < 150; index++) { engine.processCandles("BTC-USDT", candles(1, index)); position = engine.snapshot().positions.find(p => p.coordination === "dca"); if (position) break }
  assert.ok(position)
  engine.updateSettings({ volumeFactor: .02, coordinations: { ...cfg.coordinations, dca: { ...cfg.coordinations.dca, multiplier: 4, distancePct: 3 } } })
  const sign = position.direction === "long" ? 1 : -1
  engine.processTick("BTC-USDT", position.entryPrice * (1 - sign * .006), position.openedAt + 1000)
  const added = engine.snapshot().positions.find(p => p.id === position!.id)!
  assert.equal(added.fills.length, 2, "original .5% distance remains in force")
  assert.ok(Math.abs(added.fills[1].price * added.fills[1].quantity - 2) < 1e-12, "original $1 budget × 2 remains in force")
  let newLaneSeen = false
  for (const candle of candles(150, index + 1)) {
    const events = engine.processCandles("BTC-USDT", [candle]), state = engine.exportState()
    for (const event of events.filter(e => e.type === "opened")) {
      const lane = state.lanes[event.laneId]
      if (lane.coordination === "dca" && lane.id !== position.laneId) { assert.equal(lane.samples.length, 0); newLaneSeen = true; break }
    }
    if (newLaneSeen) break
  }
  assert.ok(newLaneSeen)
})

test("Axis waits for disjoint previous and last windows and records its own subsequent outcomes", () => {
  const cfg = settings()
  cfg.coordinations.axis = { enabled: true, previous: 3, last: 2, outcome: "any" }
  const engine = new TradingEngine(cfg)
  let axisOpened = 0
  for (const candle of candles(650)) {
    const events = engine.processCandles("BTC-USDT", [candle]), state = engine.exportState()
    for (const event of events.filter(e => e.type === "opened")) {
      const lane = state.lanes[event.laneId]
      if (lane.coordination !== "axis") continue
      axisOpened++
      const normal = Object.values(state.lanes).find(l => l.coordination === "normal" && l.symbol === lane.symbol && l.direction === lane.direction && l.configId === lane.configId && l.stage === lane.stage)!
      assert.ok(normal.samples.length >= 5)
      if (lane.admissionCount === 1) assert.equal(lane.samples.length, 0)
    }
  }
  assert.ok(axisOpened > 0)
})

test("validation is atomic, duplicate numeric catalog values deduplicate, and invalid settings fail closed", () => {
  const engine = new TradingEngine(settings()), before = engine.exportState()
  assert.throws(() => engine.processCandles("BTC-USDT", [bar(baseTime, 100), bar(baseTime - 1, 100)]))
  assert.deepEqual(engine.exportState(), before)
  assert.equal(generateStrategyCatalog("x", { strategyTpSteps: [3, "3"], strategySlRatios: [1, "1"], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] }).length, 1)
  assert.throws(() => generateStrategyCatalog("x", { takerFeePct: -1 }))
  assert.throws(() => validateEngineSettings({ ...settings(), maxSamples: 1 }))
})

test("balanced 252-config preset processes 100 symbols × 300 bars and ticks without synthetic exchange outcomes", () => {
  const symbols = Array.from({ length: 100 }, (_, i) => `B${i}-USDT`)
  const engine = new TradingEngine({ symbols })
  const start = performance.now()
  for (const symbol of symbols) engine.processCandles(symbol, candles(300))
  const barsMs = performance.now() - start
  const tickStart = performance.now()
  for (const symbol of symbols) engine.processTick(symbol, 101, baseTime + 300 * 60_000)
  const tickMs = performance.now() - tickStart
  const state = engine.exportState()
  assert.equal(state.processedCandles, 30_000)
  assert.equal(generateStrategyCatalog("x", DEFAULT_ENGINE_SETTINGS.catalog).length, 252)
  assert.equal(Object.keys(state.lastTimestamp).length, 100)
  assert.ok(Object.values(state.lanes).every(l => l.samples.length <= 250))
  assert.equal(state.intents.length, 0)
  assert.ok(barsMs < 120_000, `Balanced fixture exceeded 120 seconds: ${barsMs.toFixed(0)}ms`)
  console.log(JSON.stringify({ fixture: "100 symbols × 300 deterministic synthetic bars; balanced252 configs; all4 coordinations enabled; no execution", barsMs: Math.round(barsMs), allSymbolsTickMs: Math.round(tickMs), lanes: Object.keys(state.lanes).length, heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }))
})

test("limited snapshots retain complete stage metrics and cheap active-position queries", () => {
  const engine = new TradingEngine(settings())
  engine.processCandles("BTC-USDT", candles(400))
  const full = engine.snapshot(), limited = engine.snapshot({ laneLimit: 2, positionLimit: 1 })
  assert.deepEqual(limited.stages, full.stages)
  assert.equal(limited.lanes.length, Math.min(2, full.lanes.length))
  assert.equal(limited.positions.length, Math.min(1, full.positions.length))
  assert.deepEqual(engine.activePositionIds(), new Set(full.positions.map(p => p.id)))
  assert.equal(engine.hasOpenPositions(), full.positions.length > 0)
  assert.throws(() => engine.snapshot({ laneLimit: -1 }))
})

test("changing lastN or PF cohort settings starts fresh independent stage lanes", () => {
  const engine = new TradingEngine(settings())
  engine.processCandles("BTC-USDT", candles(300))
  const ids = new Set(Object.keys(engine.exportState().lanes))
  engine.updateSettings({ stageLastN: { base: 3, main: 2, real: 2 } })
  let newLaneSeen = false
  for (const candle of candles(100, 300)) {
    const events = engine.processCandles("BTC-USDT", [candle]), state = engine.exportState()
    for (const event of events.filter(e => e.type === "opened")) {
      assert.ok(!ids.has(event.laneId))
      const lane = state.lanes[event.laneId]
      if (!newLaneSeen) { assert.equal(lane.stage, "base"); assert.equal(lane.samples.length, 0); newLaneSeen = true }
    }
  }
  assert.ok(newLaneSeen)
  const full = engine.snapshot(), live = engine.snapshot({ positionStage: "live", positionLimit: 1, laneLimit: 0 })
  assert.deepEqual(live.stages, full.stages)
  assert.ok(live.positions.every(p => p.stage === "live"))
  assert.equal(live.positions.length, Math.min(1, full.positions.filter(p => p.stage === "live").length))
  assert.deepEqual(JSON.parse(engine.serializeState()), JSON.parse(JSON.stringify(engine.exportState())))
})

test("all coordination lanes qualify Base→Main→Real→Live using their own newly closed positions", () => {
  const cfg = settings({ stageLastN: { base: 1, main: 1, real: 1 } })
  cfg.coordinations.axis = { enabled: true, previous: 2, last: 1, outcome: "any" }
  cfg.coordinations.block.enabled = true; cfg.coordinations.dca.enabled = true
  const engine = new TradingEngine(cfg)
  engine.processCandles("BTC-USDT", candles(900))
  const lanes = engine.exportState().lanes
  for (const coordination of ["normal", "axis", "block", "dca"]) for (const stage of ["base", "main", "real", "live"]) {
    const own = Object.values(lanes).filter(l => l.coordination === coordination && l.stage === stage)
    assert.ok(own.some(l => l.closedCount > 0), `${coordination}/${stage} has no independently realized samples`)
    assert.ok(own.every(l => l.closedCount <= l.admissionCount))
  }
})

test("eligible Live DCA emits entry, exact add quantity and full close intents from observed ticks", () => {
  const cfg = settings({ stageLastN: { base: 1, main: 1, real: 1 }, catalog: { strategyTpSteps: [3], strategySlRatios: [2.2], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] } })
  cfg.coordinations.dca = { enabled: true, steps: 2, distancePct: .2, multiplier: 2 }
  const engine = new TradingEngine(cfg)
  let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined
  for (let i = 0; i < 1000; i++) {
    engine.processCandles("BTC-USDT", candles(1, i), { allowExecution: true })
    position = engine.snapshot({ laneLimit: 0, positionStage: "live" }).positions.find(p => p.coordination === "dca")
    if (position) break
  }
  assert.ok(position?.executionEligible)
  const sign = position.direction === "long" ? 1 : -1
  engine.processTick("BTC-USDT", position.entryPrice * (1 - sign * .003), position.openedAt + 1000)
  const added = engine.snapshot({ laneLimit: 0, positionStage: "live" }).positions.find(p => p.id === position!.id)!
  assert.equal(added.fills.length, 2)
  engine.processTick("BTC-USDT", added.entryPrice * (1 + sign * .01), position.openedAt + 2000)
  const intents = engine.pendingIntents().filter(i => i.positionId === position!.id)
  assert.deepEqual(intents.map(i => i.kind), ["entry", "add", "close"])
  assert.equal(intents[1].requestedQuantity, added.fills[1].quantity)
  assert.equal(intents[2].requestedQuantity, added.quantity)
  assert.ok(Math.abs(intents[0].requestedQuantity + intents[1].requestedQuantity - intents[2].requestedQuantity) < 1e-12)
})

test("window-sized retention preserves every event, qualification and cumulative result versus250-sample retention", () => {
  const cfg = settings({ stageLastN: { base: 4, main: 3, real: 2 } })
  cfg.coordinations.axis = { enabled: true, previous: 5, last: 2, outcome: "any" }
  cfg.coordinations.block.enabled = true; cfg.coordinations.dca.enabled = true
  const compact = new TradingEngine(cfg), reference = new TradingEngine(cfg)
  // Preserve the former implementation's retention for an independent before/after
  // comparison; all execution, qualification, costs and signals use the same inputs.
  ;(reference as unknown as { sampleRetention: () => number }).sampleRetention = () => 250
  for (const candle of candles(1500)) assert.deepEqual(compact.processCandles("BTC-USDT", [candle]), reference.processCandles("BTC-USDT", [candle]))
  assert.deepEqual(compact.snapshot(), reference.snapshot())
  const small = compact.exportState(), large = reference.exportState()
  let savedSamples = 0
  for (const [id, lane] of Object.entries(small.lanes)) {
    const stageLimit = cfg.stageLastN[lane.stage === "live" ? "real" : lane.stage]
    const limit = lane.coordination === "normal" ? Math.max(stageLimit, 7) : stageLimit
    assert.equal(lane.samples.length, Math.min(lane.closedCount, limit))
    assert.deepEqual(lane.samples, large.lanes[id].samples.slice(0, limit))
    assert.equal(lane.closedCount, large.lanes[id].closedCount)
    assert.equal(lane.grossProfit, large.lanes[id].grossProfit)
    assert.equal(lane.grossLoss, large.lanes[id].grossLoss)
    savedSamples += large.lanes[id].samples.length - lane.samples.length
  }
  assert.ok(savedSamples > 500)
  const restored = new TradingEngine(cfg, large)
  assert.deepEqual(restored.snapshot(), compact.snapshot(), "restore compacts legacy retention without changing decisions")
  assert.deepEqual(restored.processCandles("BTC-USDT", candles(100, 1500)), compact.processCandles("BTC-USDT", candles(100, 1500)))
})

test("retention expands for changed Axis windows and respects disabled Axis and per-stage boundaries", () => {
  const cfg = settings({ stageLastN: { base: 4, main: 3, real: 2 } })
  cfg.coordinations.axis = { enabled: true, previous: 5, last: 2, outcome: "any" }
  const engine = new TradingEngine(cfg)
  engine.processCandles("BTC-USDT", candles(900))
  for (const lane of Object.values(engine.exportState().lanes)) {
    const target = lane.coordination === "normal" ? 7 : cfg.stageLastN[lane.stage === "live" ? "real" : lane.stage]
    assert.equal(lane.samples.length, Math.min(lane.closedCount, target))
  }
  engine.updateSettings({ coordinations: { ...cfg.coordinations, axis: { ...cfg.coordinations.axis, previous: 8, last: 3 } } })
  engine.processCandles("BTC-USDT", candles(900, 900))
  assert.ok(Object.values(engine.exportState().lanes).some(l => l.coordination === "normal" && l.samples.length === 11))
  engine.updateSettings({ coordinations: { ...cfg.coordinations, axis: { ...cfg.coordinations.axis, enabled: false } } })
  for (const lane of Object.values(engine.exportState().lanes)) assert.ok(lane.samples.length <= cfg.stageLastN[lane.stage === "live" ? "real" : lane.stage])
  assert.equal(engine.settings.maxSamples, 250, "the user-configurable ceiling is preserved")
})
