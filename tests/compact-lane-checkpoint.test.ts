import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import { StateStore } from "../core/store"
import type { Candle } from "../core/types"

const symbol = "BTC-USDT"
const bars: Candle[] = Array.from({ length: 260 }, (_, i) => {
  const close = 100 + 7 * Math.sin(i / 4) + 2 * Math.sin(i / 11)
  return { timestamp: 1_790_000_000_000 + i * 60_000, open: close, high: close, low: close, close, volume: 100 }
})

test("lane checkpoints store each config once and restore old engine semantics", () => {
  const engine = new TradingEngine({
    symbols: [symbol], connectionId: "terminal-compact-checkpoint", stageGateMode: "parent-branches",
    stageLastN: { base: 1, main: 1, real: 1 }, stageMinPF: { base: 0, main: 0, real: 0 },
    catalog: {
      strategyEnabledRanges: ["Micro"], strategyIndicationTypes: ["Trend"], strategyTpSteps: [3],
      strategySlRatios: [1], strategyExitModes: ["fixed"], strategySignalTimeframes: [1],
      strategyLastNGrid: { base: [1, 2, 3], main: [1, 2, 3], real: [1, 2, 3] },
      strategyStageCoordinations: { main: ["normal"], real: ["normal"] },
    },
  })
  engine.processMarketCandles({ [symbol]: bars })
  const expected = JSON.parse(engine.serializeState())
  const rows = [...engine.checkpointLanes(true)]
  assert.ok(rows.length > 20)
  for (const row of rows) {
    const compact = JSON.parse(row.data)
    assert.equal("id" in compact, false, "the table key owns lane identity")
    assert.equal("config" in compact, false, "the metadata dictionary owns immutable config geometry")
  }
  const metadata = engine.checkpointMetadata()
  const envelope = JSON.parse(metadata)
  assert.ok(envelope.state && envelope.configs)
  assert.equal(Object.keys(envelope.configs).length, new Set(Object.values(expected.lanes).map(lane => lane.configId)).size)
  const compactBytes = Buffer.byteLength(metadata) + rows.reduce((sum, row) => sum + Buffer.byteLength(row.id) + Buffer.byteLength(row.data), 0)
  const fullBytes = Buffer.byteLength(engine.serializeState())
  assert.ok(compactBytes < fullBytes, `deduplicated ${compactBytes} bytes did not improve full ${fullBytes}`)

  const store = new StateStore(":memory:")
  store.migrateLaneCheckpoint(metadata, rows, [], engine.settings, () => {})
  const stored = store.database.prepare("SELECT data FROM records WHERE key='engine'").get() as { data: string }
  assert.match(stored.data, /^\{"checkpointFormat":"lane-rows-v2"/)
  const storedRows = store.database.prepare("SELECT id,data FROM engine_lanes").all() as { id:string;data:string }[]
  const storedBytes = Buffer.byteLength(stored.data) + storedRows.reduce((sum,row)=>sum+Buffer.byteLength(row.id)+Buffer.byteLength(row.data),0)
  assert.ok(storedBytes < fullBytes * .9, `stored compact ${storedBytes} bytes did not materially improve full ${fullBytes}`)
  assert.deepEqual(store.loadEngineState(), expected)
  store.database.close()
})
