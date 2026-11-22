import assert from "node:assert/strict"
import { test } from "node:test"
import { generateStrategyCatalog } from "../core/catalog"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { DEFAULT_RELATE, relateAllocation } from "../core/relate"
import type { Candle } from "../core/types"

const catalog = {
  strategyEnabledRanges: ["Short"], strategyTpSteps: [12], strategySlRatios: [.5, 1],
  strategyExitModes: ["fixed"], strategyIndicationTypes: ["Trend"],
}
const policy = { ...DEFAULT_RELATE, enabled: true, lastN: 60 }
const symbol = "BTC-USDT"

test("Relate sizes only qualified own returns within the configured stop and stack caps", () => {
  const [tight, wide] = generateStrategyCatalog("test", catalog)
  const sample = [...Array(3).fill(1), -.1, ...Array(56).fill(.2)]
  assert.equal(relateAllocation(sample, tight, policy), 1.6)
  assert.equal(relateAllocation(sample, wide, policy), 1)
  assert.equal(relateAllocation(sample.slice(0,59), tight, policy), 1)
  assert.equal(relateAllocation([-1, ...sample.slice(1)], tight, policy), 1)
  assert.equal(relateAllocation([1, NaN, ...sample.slice(2)], tight, policy), 1)
  assert.equal(relateAllocation(sample, {...tight, exitMode: "trailing-only-fixed"}, policy), 1)
  assert.equal(relateAllocation(sample, tight, {...policy, maxMultiplier: 1.2}), 1.2)
  assert.throws(() => validateEngineSettings({coordinations: {
    ...validateEngineSettings().coordinations, relate: {...policy, minTrades: 61},
  }}), /Relate minimum samples/)
})

test("Relate's Real allocation and exact Live mirror survive a checkpoint without borrowing another Set", () => {
  const bars = Array.from({length:480}, (_, i): Candle => {
    const close = 100 + 8 * Math.sin(i / 5) + Math.sin(i / 11)
    return { timestamp:1_790_000_000_000 + i * 60_000, open:close, high:close, low:close, close, volume:1 }
  })
  const defaults = validateEngineSettings()
  const engine = new TradingEngine({
    symbols: [symbol], stageGateMode: "processed-sets", catalog,
    stageLastN:{ base:1, main:1, real:1 }, stageMinPF:{ base:0, main:0, real:0 },
    coordinations: {
      ...defaults.coordinations,
      axis: {...defaults.coordinations.axis, enabled:false},
      block: {...defaults.coordinations.block, enabled:false},
      dca: {...defaults.coordinations.dca, enabled:false},
      relate: policy,
    },
  })
  engine.processCandles(symbol, bars.slice(0,250))
  const state = engine.exportState()
  const relationLanes = Object.values(state.lanes).filter(lane => lane.coordination === "relate" && lane.stage === "real")
  assert.ok(relationLanes.length >= 2)
  for (const lane of relationLanes) {
    lane.samples = Array.from({length:60}, () => 1)
    lane.sampleTimes = Array.from({length:60}, (_, i) => bars[249 - i].timestamp)
  }
  const resumed = TradingEngine.fromSerialized(JSON.stringify(state))
  const seen = new Map<number, number>()
  for (const bar of bars.slice(250)) {
    resumed.processCandles(symbol, [bar], {allowExecution: true})
    const snapshot = resumed.exportState()
    for (const lane of Object.values(snapshot.lanes)) {
      if (lane.coordination !== "relate" || lane.stage !== "live" || lane.open?.openedAt !== bar.timestamp) continue
      const position = lane.open
      const parent = Object.values(snapshot.lanes).find(row => row.open?.id === position.parentPositionId)!
      assert.equal(parent.configId, lane.configId)
      assert.deepEqual(parent.open!.fills, position.fills)
      const intent = resumed.pendingIntents().find(item => item.positionId === position.id && item.kind === "entry")
      assert.equal(intent?.entryAllocationRatio, position.notional / position.sizing!.baseBudget)
      const ratio = lane.config.slRatio!
      if (ratio === 1 || position.notional > position.sizing!.baseBudget) seen.set(ratio, intent!.entryAllocationRatio!)
    }
    if (seen.size === 2) break
  }
  assert.equal(seen.get(.5), 2)
  assert.equal(seen.get(1), 1)
})
test("Relate increases volume only when its own recent PF clears the disjoint Auto PF floor", () => {
  const settings = {...DEFAULT_RELATE,enabled:true,lastN:60,minTrades:60}
  const config = {...generateStrategyCatalog("test",{strategyTpSteps:[3],strategySlRatios:[.5],strategyExitModes:["fixed"]})[0],
    autoPfPolicy:{fallback:1.1,minSamples:16,history:40,adjustment:.75,cap:2}}
  const recent = [...Array<number>(33).fill(1),...Array<number>(27).fill(-1)]
  const weak = [...recent,...Array<number>(16).fill(-1)]
  assert.ok(relateAllocation(recent,config,settings,recent.length)>1)
  assert.equal(relateAllocation(weak,config,settings,weak.length),1)
  assert.ok(relateAllocation(weak,config,settings,weak.length-1)>1,"untimed older returns leave the fallback in force")
})
