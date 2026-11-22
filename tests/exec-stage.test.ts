import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine, windowMetrics } from "../core/engine"
import { checkExecWindows, DEFAULT_EXEC_WINDOWS, execBlockPolicy, execPathCount } from "../core/last-n-grid"
import { StateStore } from "../core/store"
import type { Candle, EngineSettings, ClosedTrade } from "../core/types"
import { blockPrefix, evaluateBlocks } from "../shared/cts-lastn/blocks"

const symbol = "BTC-USDT"
const makeBar = (index: number): Candle => {
  const close = 100 * 1.006 ** index
  return { timestamp: 1790000000000 + index * 60_000, open: close, high: close, low: close, close, volume: 1 }
}
const bars = Array.from({ length: 202 }, (_, i) => makeBar(i))
const settings: Partial<EngineSettings> = {
  symbols: [symbol], stageGateMode: "exec-branches", baseNotional: 100, volumeFactor: 1,
  coordinations: {
    axis: { ...DEFAULT_ENGINE_SETTINGS.coordinations.axis, enabled: false },
    block: { ...DEFAULT_ENGINE_SETTINGS.coordinations.block, enabled: false },
    dca: { ...DEFAULT_ENGINE_SETTINGS.coordinations.dca, enabled: false },
  },
  catalog: {
    strategyEnabledRanges: ["Micro"], strategyIndicationTypes: ["Trend"], strategySignalPeriods: [10],
    strategyTpSteps: [3], strategySlRatios: [1], strategyExitModes: ["fixed"],
    strategyExecWindows: {
      base: { long: [10,20], short: [4], last: [1] },
      main: { long: ["none","inherit"], short: [4], last: [1] },
      real: { long: ["none"], short: [4], last: [1] },
      exec: { long: ["none","inherit"], short: [4], last: [1] },
    },
  },
}

test("Exec policies use separate chronological blocks and reject an incomplete or failed block", () => {
  assert.equal(execPathCount(checkExecWindows(DEFAULT_EXEC_WINDOWS)), 6_400_000)
  assert.throws(() => checkExecWindows({ real: { short: [] } }))
  const withLong = execBlockPolicy(10,4,2), short = execBlockPolicy(0,4,2)
  const samples = [1,1, 1,1,1,1, ...Array<number>(10).fill(-1)]
  const result = evaluateBlocks(blockPrefix(samples), withLong, 1.1)
  assert.deepEqual([result.long.offset,result.short.offset,result.minimal.offset],[6,2,0])
  assert.equal(result.long.state,"failed")
  assert.equal(result.short.state,"qualified")
  assert.equal(result.minimal.state,"qualified")
  assert.equal(evaluateBlocks(blockPrefix(samples),short,1.1).state,"qualified")
  assert.throws(()=>evaluateBlocks(blockPrefix(samples),{...short,lastRequiresPF:undefined},1.1),/Invalid disjoint/)
  assert.equal(evaluateBlocks(blockPrefix(samples.slice(0,5)),short,1.1).state,"insufficient")
  assert.equal(evaluateBlocks(blockPrefix([2,-1.9,1,1,1,1]),short,1.1).minimal.state,"failed")
  assert.equal(windowMetrics(undefined, 5, 1.1, short).qualified,false)
})

test("fresh parent entries fund independent child Sets and Exec mirrors without a Live window", () => {
  const engine = new TradingEngine(settings)
  engine.processCandles(symbol,bars.slice(0,39))
  assert.ok(Object.values(engine.exportState().lanes).every(lane=>lane.stage==="base"&&lane.baseObservation))
  assert.deepEqual(engine.snapshot().stages[0].baseCandidates,{observed:2,enoughSamples:0})
  const observed = new Map<string, ClosedTrade>()
  engine.observeStageCloses(trade=>observed.set(trade.id,trade))
  engine.processCandles(symbol,bars.slice(39,-2),{eventLimit:0})
  const db = new StateStore(":memory:")
  try {
    db.migrateLaneCheckpoint(engine.checkpointMetadata(),engine.checkpointLanes(true),[],engine.settings,()=>{})
    const restarted = TradingEngine.fromOwnedCheckpoint(db.loadEngineState()!)
    const checkpoint = engine.snapshot()
    assert.deepEqual(restarted.snapshot(),checkpoint)
    const book = engine.exportState().lanes
    const lanes = Object.values(book), exec = lanes.filter(lane=>lane.stage==="exec")
    assert.equal(exec.length, 8, "each Real Set has an Exec child with and without the originating Base Long")
    const byStage = checkpoint.stages.find(row=>row.stage==="exec")!
    assert.ok(byStage.executed!.closed>0)
    assert.ok(byStage.closed>byStage.executed!.closed,"Exec warming closes are excluded from Executed PF")
    assert.equal(checkpoint.stages.find(row=>row.stage==="live")!.closed,byStage.executed!.closed)
    for (const lane of lanes.filter(lane=>lane.stage!=="base")) {
      const parent = book[lane.parentProof!.at(-1)!.laneId]
      const windows = lane.config.branch!.windows!
      assert.equal(lane.config.branch!.geometryId,parent.config.branch!.geometryId)
      if (lane.stage === "live") {
        assert.equal(parent.stage,"exec")
        assert.equal(lane.samples.length,0)
        assert.equal(lane.closedCount,parent.executed!.closed)
      } else {
        const policy = windows[lane.stage]!
        assert.ok(policy.long===0||policy.long===windows.base!.long)
        assert.ok(lane.samples.length<=policy.long+policy.short+policy.minimal+1)
      }
    }
    for (const trade of observed.values()) {
      if (trade.stage === "base") continue
      const parentTrade = observed.get(trade.parentPositionId!)
      if (parentTrade) assert.equal(parentTrade.openedAt,trade.openedAt)
      assert.ok(trade.admission!.every(proof=>proof.qualified&&proof.checkedAt===trade.openedAt&&proof.count===proof.required))
      if (trade.stage==="live" && parentTrade) {
        assert.equal(parentTrade.stage,"exec")
        assert.equal(trade.netReturnPct,parentTrade.netReturnPct)
        assert.equal(trade.cost,parentTrade.cost)
      }
    }
    for (const bar of bars.slice(-2)) assert.deepEqual(restarted.processCandles(symbol,[bar],{allowExecution:true}),engine.processCandles(symbol,[bar],{allowExecution:true}))
    const intents = engine.pendingIntents().filter(intent=>intent.kind==="entry")
    assert.ok(intents.length)
    for (const intent of intents) {
      assert.equal(intent.source,"exec-qualified")
      assert.ok(intent.execPositionId)
      assert.ok(Math.abs(intent.notional-20)<1e-9)
    }
    assert.deepEqual(restarted.pendingIntents(),engine.pendingIntents())
  } finally { db.close() }
})
