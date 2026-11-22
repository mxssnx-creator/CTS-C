import assert from "node:assert/strict"
import { test } from "node:test"
import { generateStrategyCatalog } from "../core/catalog"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from "../core/engine"
import { LAST_N_STAGES } from "../core/last-n-grid"
import { STOP_DISTANCE_PCTS, TRAIL_DISTANCE_PCTS } from "../core/protection-grid"
import { DEFAULTS, configurationCount, hydrate, validateConfiguration } from "../core/settings-schema"
import { EXIT_MODES, type Candle } from "../core/types"

test("all exact protection distances and both trailing types have their own catalog IDs and Auto PF", () => {
  const settings = validateConfiguration({ ...DEFAULTS, stageGateMode:"parent-branches", strategyEnabledRanges: ["Short"], strategyTpSteps: [12],
    strategyIndicationTypes: ["Trend"], strategyExitModes: [...EXIT_MODES], strategyPriceDistancesEnabled: true,
    strategyLastNGrid: { base: [8, 12] }, autoPfEnabled: true })
  const rows = generateStrategyCatalog("offline", settings)
  assert.equal(rows.length, 2 * 21 * (1 + 25 * 4))
  assert.equal(configurationCount(settings), rows.length)
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  assert.deepEqual([...new Set(rows.map(row => +(row.stoploss * 100).toFixed(1)))], STOP_DISTANCE_PCTS)
  assert.deepEqual([...new Set(rows.filter(row => row.trailing).map(row => row.trailDistancePct))], TRAIL_DISTANCE_PCTS)
  assert.ok(rows.every(row => (row.autoPfFloor ?? 0) > 1 && row.stageLastN?.base))
  assert.deepEqual(hydrate(Object.fromEntries(Object.entries(settings).map(([key, value]) =>
    [key, typeof value === "object" ? JSON.stringify(value) : String(value)]))), settings)
  assert.throws(() => generateStrategyCatalog("offline", { ...settings, strategyStopDistancePcts: [.21] }), /0.1 percentage-point/)
  assert.throws(() => validateConfiguration({ strategyLastNGrid: { main: [8, 8] } }, { partial: true }), /Last-N grid/)
})

test("Base, Main, Real and restored Live retain the owning exact geometry and Last-N proof", () => {
  const symbol = "BTC-USDT"
  const settings = {
    symbols: [symbol], stageGateMode: "processed-sets" as const, stageWindowScope: "both" as const,
    stageLastN: { base: 5, main: 5, real: 5 }, stageMinPF: { base: 1.01, main: 1.01, real: 1.01 },
    catalog: { strategyEnabledRanges: ["Short"], strategyTpSteps: [12], strategyIndicationTypes: ["Trend"],
      strategyExitModes: ["fixed", "trailing", "trailing-fixed"], strategyPriceDistancesEnabled: true,
      strategyStopDistancePcts: [.4, .9], strategyTrailDistancePcts: [.7],
      strategyLastNGrid: { base: [1, 3], main: [1, 2], real: [1, 2] }, autoPfEnabled: true },
    coordinations: { axis: { ...DEFAULT_ENGINE_SETTINGS.coordinations.axis, enabled: false },
      block: { ...DEFAULT_ENGINE_SETTINGS.coordinations.block, enabled: false },
      dca: { ...DEFAULT_ENGINE_SETTINGS.coordinations.dca, enabled: false } },
  }
  const bars: Candle[] = Array.from({ length: 600 }, (_, i) => {
    const close = 100 + 9 * Math.sin(i / 5) + 2 * Math.sin(i / 13)
    return { timestamp: 1_790_000_000_000 + i * 60_000, open: close, high: close, low: close, close, volume: 100 }
  })
  const engine = new TradingEngine(settings)
  engine.processMarketCandles({ [symbol]: bars.slice(0, 300) })
  const restored = TradingEngine.fromSerialized(engine.serializeState())
  restored.processMarketCandles({ [symbol]: bars.slice(300) })
  engine.processMarketCandles({ [symbol]: bars.slice(300) })
  const actual = restored.exportState()
  assert.deepEqual(actual, engine.exportState())
  const owned = Object.values(actual.lanes).filter(lane => lane.stage === "live" && lane.admissionCount > 0)
  assert.ok(owned.length > 0)
  assert.deepEqual(new Set(owned.map(lane => lane.config.exitMode)), new Set(["fixed", "trailing", "trailing-fixed"]))
  assert.ok(new Set(owned.map(lane => JSON.stringify(lane.config.stageLastN))).size > 1)
  for (const lane of owned) {
    assert.equal(lane.parentProof?.length, 3)
    for (const [i, proof] of lane.parentProof!.entries()) {
      const stage = LAST_N_STAGES[i]
      assert.equal(proof.required, lane.config.stageLastN?.[stage])
      assert.equal(proof.windowScope, "both")
      assert.equal(proof.minPF, Math.max(settings.stageMinPF[stage], lane.config.autoPfFloor!))
      assert.equal(actual.lanes[proof.laneId].configId, lane.configId)
      assert.equal(actual.lanes[proof.laneId].stage, stage)
    }
  }
  assert.deepEqual(restored.pendingIntents(), [])
})
