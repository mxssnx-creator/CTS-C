import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import type { Candle, EngineState } from "../core/types"

const symbol = "BTC-USDT"
const bars: Candle[] = Array.from({ length: 260 }, (_, i) => {
  const close = 100 + 7 * Math.sin(i / 4) + 2 * Math.sin(i / 11)
  return { timestamp: 1_790_000_000_000 + i * 60_000, open: close, high: close, low: close, close, volume: 100 }
})
const create = () => {
  const engine = new TradingEngine({
    symbols: [symbol], connectionId: "terminal-lineage-intern", stageGateMode: "parent-branches",
    stageLastN: { base: 1, main: 1, real: 1 }, stageMinPF: { base: 0, main: 0, real: 0 },
    catalog: {
      strategyEnabledRanges: ["Micro"], strategyIndicationTypes: ["Trend"], strategyTpSteps: [3],
      strategySlRatios: [1], strategyExitModes: ["fixed"], strategySignalTimeframes: [1],
      strategyLastNGrid: { base: [1, 2, 3], main: [1, 2, 3], real: [1, 2, 3] },
      strategyStageCoordinations: { main: ["normal"], real: ["normal"] },
    },
  })
  engine.processMarketCandles({ [symbol]: bars })
  return engine
}
function assertInterned(state: EngineState) {
  const references = Object.values(state.lanes).flatMap(lane => lane.parentProof ?? [])
  assert.ok(references.length > 20, "fixture must create recursive parent evidence")
  let recursivePrefixes = 0
  for (const lane of Object.values(state.lanes)) {
    const chain = lane.parentProof
    if (!chain || chain.length < 2) continue
    const parent = state.lanes[chain.at(-1)!.laneId]
    assert.ok(parent?.parentProof, "recursive proof must resolve its immediate parent")
    for (let i = 0; i < chain.length - 1; i++) {
      recursivePrefixes++
      assert.equal(chain[i], parent.parentProof![i], "child must reuse its parent's immutable ancestor proof")
      assert.deepEqual(chain[i], parent.parentProof![i])
    }
  }
  assert.ok(recursivePrefixes > 10, "fixture must reproduce copied recursive prefixes")
  return { references: references.length, uniqueObjects: new Set(references).size, recursivePrefixes }
}

test("recursive parent lineage shares immutable ancestor proofs before and after restart", () => {
  const engine = create()
  const before = JSON.parse(engine.serializeState()) as EngineState
  const active = engine.exportState()
  const stats = assertInterned(active)
  assert.ok(stats.uniqueObjects < stats.references)
  assert.deepEqual(JSON.parse(JSON.stringify(active)), before)

  const restored = TradingEngine.fromSerialized(engine.serializeState())
  const restoredState = restored.exportState()
  assertInterned(restoredState)
  assert.deepEqual(JSON.parse(restored.serializeState()), before)
})
