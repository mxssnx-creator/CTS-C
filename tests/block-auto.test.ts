import assert from "node:assert/strict"
import { test } from "node:test"
import { blockStepVerdict, settleBlockSteps } from "../core/block-auto"
import { blockRoundBudget } from "../core/block-rounds"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { flatEngineSettings, validateConfiguration } from "../core/settings-schema"
import type { Candle, LaneState } from "../core/types"

const symbol = "BTC-USDT"
const auto = { enabled: true, lastN: 4, minSamples: 3, minPF: 1.1 }
const bars = Array.from({ length: 420 }, (_, i): Candle => {
  const close = 100 + 9 * Math.sin(i / 5) + 2 * Math.sin(i / 13)
  return { timestamp: 1_790_000_000_000 + 60_000 * i, open: close, high: close, low: close, close, volume: 100 }
})

function settings(behavior: "pyramid" | "rounds" = "pyramid", enabled = true) {
  return validateEngineSettings({
    symbols: [symbol], stageGateMode: "processed-sets",
    stageLastN: { base: 1, main: 1, real: 1 }, stageMinPF: { base: 0, main: 0, real: 0 },
    catalog: { strategyEnabledRanges: ["Short"], strategyTpSteps: [12], strategySlRatios: [1], strategyExitModes: ["fixed"], strategyIndicationTypes: ["Trend"] },
    coordinations: {
      axis: { enabled: false, previous: 1, last: 1, outcome: "any" },
      dca: { enabled: false, steps: 1, distancePct: 1, multiplier: 1 },
      block: { enabled: true, behavior, steps: 2, mode: "shared", ratio: .2, size: 1, auto: { ...auto, enabled } },
    },
  })
}

test("Block pyramid only adds from the exact Real step and keeps observed probes across restart", () => {
  const policy = settings()
  const engine = new TradingEngine(policy)
  let live: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined
  for (const bar of bars) {
    engine.processCandles(symbol, [bar], { allowExecution: true })
    live = engine.snapshot({ laneLimit: 0, positionStage: "live" }).positions.find(row => row.coordination === "block")
    if (live) break
  }
  assert.ok(live?.executionEligible)
  const source = engine.exportState()
  const real = Object.values(source.lanes).find(lane => lane.open?.id === live.parentPositionId)!
  real.blockStepReturns = [[.5, .4, -.1], [-.5, -.4, .1]]
  source.lanes[live.laneId].blockStepReturns = [[-.5, -.4, .1], [.5, .4, -.1]]
  const sign = live.direction === "long" ? 1 : -1
  const move = sign * live.takeProfitPct / 100 * .36
  const first = live.entryPrice * (1 + move)
  const second = first * (1 + move)
  const restored = new TradingEngine(policy, source)
  restored.processTick(symbol, first, live.openedAt + 1000)
  const resumed = TradingEngine.fromSerialized(restored.serializeState())
  resumed.processTick(symbol, second, live.openedAt + 2000)
  const paired = resumed.exportState().lanes
  assert.deepEqual(paired[real.id].open!.blockProbePrices, [first, second])
  assert.equal(paired[real.id].open!.fills.length, 2)
  assert.deepEqual(paired[live.laneId].open!.fills, paired[real.id].open!.fills)
  assert.deepEqual(resumed.pendingIntents().filter(intent => intent.positionId === live.id).map(intent => intent.kind), ["entry", "add"])

  const exit = live.entryPrice * (1 + 3 * sign * live.takeProfitPct / 100)
  resumed.processTick(symbol, exit, live.openedAt + 3000)
  const settled = resumed.exportState().lanes
  const evidence = settled[real.id].blockStepReturns!
  assert.equal(evidence[0][0], sign * (exit - first) / first * 100 - live.costPct)
  assert.equal(evidence[1][0], sign * (exit - second) / second * 100 - live.costPct)
  assert.deepEqual(settled[live.laneId].blockStepReturns, source.lanes[live.laneId].blockStepReturns)
})

test("Block rounds gate each budget increase and score held levels once at the parent's close", () => {
  const policy = settings("rounds")
  const engine = new TradingEngine(policy)
  let lane: LaneState | undefined
  for (const bar of bars) {
    engine.processCandles(symbol, [bar])
    lane = Object.values(engine.exportState().lanes).find(row => row.coordination === "block" && row.open)
    if (lane) break
  }
  assert.ok(lane)
  const block = policy.coordinations.block
  const position = lane.open!
  lane.blockRound = { closed: 0, sum: 0, net: -4, level: 2, pauseRemaining: 0, rounds: 2 }
  lane.blockStepReturns = [[.3, .2, -.1], [.3, null, .2]]
  assert.equal(blockRoundBudget(lane, block), 1)
  assert.equal(blockStepVerdict(lane, 2, auto).state, "unknown")
  lane.blockStepReturns[1] = [.2, -.05]
  position.blockRoundLevel = 2
  settleBlockSteps(lane, position, position.entryPrice, .3)
  assert.deepEqual(lane.blockStepReturns, [[.3, .2, -.1], [.3, .2, -.05]])
  assert.equal(blockRoundBudget(lane, block), 1.4)
  assert.equal(blockRoundBudget({ ...lane, blockStepReturns: undefined }, block), 1)
})

test("manual Block keeps its existing Set IDs and new Auto settings form a distinct policy", () => {
  const manual = settings("pyramid", false)
  delete manual.coordinations.block.auto
  const engine = new TradingEngine(manual)
  engine.processCandles(symbol, bars.slice(0, 180))
  const ids = () => engine.snapshot().lanes.filter(lane => lane.coordination === "block" && lane.current).map(lane => lane.id)
  const previous = ids()
  assert.ok(previous.length)
  engine.updateSettings(settings("pyramid", false))
  assert.deepEqual(ids(), previous)
  engine.updateSettings(settings())
  assert.deepEqual(ids(), [])
  engine.processCandles(symbol, bars.slice(180))
  assert.ok(ids().length)
  assert.ok(ids().every(id => !previous.includes(id)))
  const fields = flatEngineSettings(engine.settings, { symbolCount: 1, historyCandles: 100 })
  assert.equal(validateConfiguration(fields).blockAutoLastN, 4)
  assert.throws(() => validateConfiguration({ ...fields, blockAutoMinSamples: 5 }), /Block Auto minimum observations/)
})
