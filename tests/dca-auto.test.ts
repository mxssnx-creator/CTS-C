import assert from "node:assert/strict"
import { test } from "node:test"
import { dcaStepVerdict, DEFAULT_DCA_AUTO } from "../core/dca-auto"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { flatEngineSettings, validateConfiguration } from "../core/settings-schema"
import type { Candle, EngineSettings, LaneState } from "../core/types"

const time = 1_790_000_000_000
const bar = (i: number): Candle => {
  const price = 100 + 10 * Math.sin(i / 5) + 2 * Math.sin(i / 13)
  return { timestamp: time + i * 60_000, open: price, high: price, low: price, close: price, volume: 100 }
}

function config(auto = true): EngineSettings {
  return validateEngineSettings({
    symbols: ["BTC-USDT"], stageGateMode: "processed-sets",
    stageLastN: { base: 1, main: 1, real: 1 }, stageMinPF: { base: 0, main: 0, real: 0 },
    catalog: { strategyTpSteps: [3], strategySlRatios: [1.6], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"] },
    coordinations: {
      axis: { enabled: false, previous: 2, last: 1, outcome: "any" },
      block: { enabled: false, steps: 1, ratio: .2, mode: "shared" },
      dca: { enabled: true, steps: 2, distancePct: .08, multiplier: 2,
        ...(auto ? { auto: { enabled: true, minSamples: 3, lastN: 4, minPF: 1.1 } } : {}) },
    },
  })
}

function liveDca(engine: TradingEngine) {
  return engine.snapshot({ laneLimit: 0, positionStage: "live" }).positions.find(p => p.coordination === "dca")
}

test("DCA Auto only uses finite recent outcomes of the exact step", () => {
  const policy = config().coordinations.dca.auto!
  const lane = { dcaStepReturns: [[.5, .4, -.2, -.1, -10], [.2, null, .3]] } as LaneState
  assert.equal(dcaStepVerdict(lane, 1, policy).state, "qualified")
  assert.equal(dcaStepVerdict(lane, 2, policy).state, "unknown")
  assert.equal(dcaStepVerdict(lane, 3, policy).state, "warming")
  lane.dcaStepReturns![1] = [0, 0, 0]
  assert.equal(dcaStepVerdict(lane, 2, policy).state, "held")
})

test("cold DCA observes multiple steps without adding and retains both after restart", () => {
  const settings = config(), engine = new TradingEngine(settings)
  let position: ReturnType<TradingEngine["snapshot"]>["positions"][number] | undefined
  for (let i = 0; i < 150 && !position; i++) {
    engine.processCandles("BTC-USDT", [bar(i)])
    position = engine.snapshot({ laneLimit: 0 }).positions.find(p => p.coordination === "dca" && p.stage === "base")
  }
  assert.ok(position)
  const sign = position.direction === "long" ? 1 : -1
  const first = position.entryPrice * (1 - sign * .001)
  const second = first * (1 - sign * .001)
  engine.processTick("BTC-USDT", first, position.openedAt + 1000)
  const restored = new TradingEngine(settings, JSON.parse(engine.serializeState()))
  const before = restored.exportState().lanes[position.laneId].open!
  assert.deepEqual(before.dcaProbePrices, [first])
  restored.processTick("BTC-USDT", second, position.openedAt + 2000)
  const after = restored.exportState().lanes[position.laneId].open!
  assert.deepEqual(after.dcaProbePrices, [first, second])
  assert.equal(after.fills.length, 1)
  const exit = position.entryPrice * (1 + sign * .01)
  restored.processTick("BTC-USDT", exit, position.openedAt + 3000)
  const scopes = restored.exportState().lanes[position.laneId].dcaStepReturns!
  for (let i = 0; i < 2; i++) {
    const price = [first, second][i]
    assert.equal(scopes[i][0], sign * (exit - price) / price * 100 - position.costPct)
  }
})

test("processed Live owns the Real allocation and cannot borrow proof from another step", () => {
  const settings = config(), engine = new TradingEngine(settings)
  let position: ReturnType<typeof liveDca>
  for (let i = 0; i < 1000 && !position; i++) {
    engine.processCandles("BTC-USDT", [bar(i)], { allowExecution: true })
    position = liveDca(engine)
  }
  assert.ok(position?.executionEligible)
  const state = engine.exportState()
  const real = Object.values(state.lanes).find(l => l.open?.id === position.parentPositionId)!
  const live = state.lanes[position.laneId]
  real.dcaStepReturns = [[.5, .4, -.1], [-1, -1, .01]]
  live.dcaStepReturns = [[-1, -1, .01], [.5, .4, -.1]]
  const restored = new TradingEngine(settings, state)
  const sign = position.direction === "long" ? 1 : -1
  const first = position.entryPrice * (1 - sign * .001)
  restored.processTick("BTC-USDT", first, position.openedAt + 1000)
  const second = first * (1 - sign * .001)
  restored.processTick("BTC-USDT", second, position.openedAt + 2000)
  const next = restored.exportState()
  assert.deepEqual(next.lanes[real.id].open!.fills, next.lanes[live.id].open!.fills)
  assert.equal(next.lanes[real.id].open!.fills.length, 2)
  assert.deepEqual(next.lanes[real.id].open!.dcaProbePrices, [first, second])
  const intents = restored.pendingIntents().filter(i => i.positionId === position.id)
  assert.deepEqual(intents.map(i => i.kind), ["entry", "add"])
  assert.equal(intents[1].requestedQuantity, next.lanes[real.id].open!.fills[1].quantity)
})

test("Auto terms produce new lanes and an off policy keeps legacy lane identities", () => {
  const manual = config(false), original = new TradingEngine(manual)
  original.processCandles("BTC-USDT", Array.from({ length: 300 }, (_, i) => bar(i)))
  const before = original.exportState()
  const off = structuredClone(manual)
  off.coordinations.dca.auto = { ...DEFAULT_DCA_AUTO, lastN: 40 }
  const restored = new TradingEngine(off, before)
  assert.equal(restored.snapshot().lanes.filter(l => l.coordination === "dca" && l.current).length,
    original.snapshot().lanes.filter(l => l.coordination === "dca" && l.current).length)
  restored.updateSettings(config())
  assert.ok(restored.snapshot().lanes.filter(l => l.coordination === "dca").every(l => l.current === false))
  restored.processCandles("BTC-USDT", Array.from({ length: 300 }, (_, i) => bar(300 + i)))
  assert.ok(restored.snapshot().lanes.some(l => l.coordination === "dca" && l.current && !before.lanes[l.id]))
  const settings = flatEngineSettings(restored.settings, { symbolCount: 1, historyCandles: 100 })
  assert.equal(validateConfiguration(settings).dcaAutoLastN, 4)
  assert.throws(() => validateConfiguration({ ...settings, dcaAutoMinSamples: 5 }), /cannot exceed/)
})
