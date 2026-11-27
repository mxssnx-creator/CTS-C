import assert from "node:assert/strict"
import { test } from "node:test"
import { generateStrategyCatalog } from "../core/catalog"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { DEFAULT_RELATE, relateAllocation, relateDecision, relateExecution } from "../core/relate"
import type { Candle } from "../core/types"
import type { RelateTrial } from "../shared/cts-relate/recovery"

const catalog = {
  strategyEnabledRanges: ["Short"], strategyTpSteps: [12], strategySlRatios: [.5, 1],
  strategyExitModes: ["fixed"], strategyIndicationTypes: ["Trend"],
}
const policy = { ...DEFAULT_RELATE, enabled: true, lastN: 60 }
const symbol = "BTC-USDT"

test("Relate sizes only qualified own returns within the configured stop and stack caps", () => {
  const [tight, wide] = generateStrategyCatalog("test", catalog)
  const sample = [...Array(3).fill(-.1), 1, ...Array(56).fill(.2)]
  assert.equal(relateAllocation(sample, tight, policy), 1.2 ** 3)
  assert.equal(relateAllocation([0, ...sample.slice(1)], tight, policy), 1)
  assert.equal(relateAllocation(sample, wide, policy), 1)
  assert.equal(relateAllocation(sample.slice(0,59), tight, policy), 1)
  assert.equal(relateAllocation([-20, ...sample.slice(1)], tight, policy), 1)
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
    lane.samples = Array.from({length:60}, (_, index) => index < 4 ? -.01 : 1)
    lane.sampleTimes = Array.from({length:60}, (_, i) => bars[249 - i].timestamp)
    lane.relateTrials = Array.from({length:16}, (_, i) => [bars[244 - i].timestamp, 4, i % 4 === 0 ? -.1 : 1, 2])
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
      if (position.notional > position.sizing!.baseBudget) seen.set(ratio, intent!.entryAllocationRatio!)
    }
    if (seen.size === 1) break
  }
  assert.equal(seen.get(.5), 2)
  assert.equal(seen.get(1), undefined)
})
test("Relate increases volume only when its own recent PF clears the disjoint Auto PF floor", () => {
  const settings = {...DEFAULT_RELATE,enabled:true,lastN:60,minTrades:60}
  const config = {...generateStrategyCatalog("test",{strategyTpSteps:[3],strategySlRatios:[.5],strategyExitModes:["fixed"]})[0],
    autoPfPolicy:{fallback:1.1,minSamples:16,history:40,adjustment:.75,cap:2}}
  const recent = [-1,...Array<number>(33).fill(1),...Array<number>(26).fill(-1)]
  const weak = [...recent,...Array<number>(16).fill(-1)]
  assert.ok(relateAllocation(recent,config,settings,recent.length)>1)
  assert.equal(relateAllocation(weak,config,settings,weak.length),1)
  assert.ok(relateAllocation(weak,config,settings,weak.length-1)>1,"untimed older returns leave the fallback in force")
})

test("closed Relate orders retain each exact Overall relation's entry-time recovery receipt", () => {
  const defaults = validateEngineSettings();
  const setup = new TradingEngine({ symbols: [symbol], stageGateMode: "processed-sets", catalog,
    stageLastN: { base: 1, main: 1, real: 1 }, stageMinPF: { base: 0, main: 0, real: 0 },
    coordinations: { ...defaults.coordinations, relate: { ...policy, scope: "overall" } } });
  const first = 1_790_000_000_000;
  const bars = Array.from({ length: 320 }, (_, i): Candle => {
    const close = 100 + 8 * Math.sin(i / 5) + Math.sin(i / 11);
    return { timestamp: first + i * 60_000, open: close, high: close, low: close, close, volume: 1 };
  });
  let index = 180;
  setup.processCandles(symbol, bars.slice(0, index));
  let state = setup.exportState();
  let lane = Object.values(state.lanes).find(l => l.coordination === "relate" && l.stage === "real" && l.open);
  while (!lane && index < 270) {
    setup.processCandles(symbol, [bars[index++]]);
    state = setup.exportState();
    lane = Object.values(state.lanes).find(l => l.coordination === "relate" && l.stage === "real" && l.open);
  }
  assert.ok(lane?.open);
  lane.open.relateRelationTrials = { overall: { step: 2, size: 1.44 }, symbol: { step: 3, size: 1.72 } };
  const resumed = TradingEngine.fromOwnedCheckpoint(state);
  resumed.processCandles(symbol, bars.slice(index));
  const settled = Object.values(resumed.exportState().relateWindows ?? {}).flat().filter(row => row[2] === lane.id && row[3]);
  assert.ok(settled.some(row => row[3]?.step === 2 && row[3].size === 1.44));
  assert.ok(settled.some(row => row[3]?.step === 3 && row[3].size === 1.72));
});

test("Overall sizes each relation from its own window only after the exact Set qualifies", () => {
  const [config] = generateStrategyCatalog("test", catalog)
  const settings = {...policy, scope: "overall" as const,
    volumeFactors: {overall: 3, symbol: 1, config: 0, direction: 0, indication: 0, strategy: 0, coordination: 0, range: 0}}
  const own = Array<number>(60).fill(1)
  const level = (source: string) => source === "overall" ? 2 : 0
  assert.equal(relateAllocation([], config, settings, 0, level), 1)
  assert.equal(relateAllocation(own, config, settings, 60, level), 1 + .75 * (1.2 ** 2 - 1))
})

test("Relate Active leaves its first loss step in the internal tape and activates after two", () => {
  const [config] = generateStrategyCatalog("test", catalog)
  const active = {...policy, activeStep: 2}
  assert.deepEqual(relateDecision([-0.1, ...Array<number>(59).fill(1)], config, active), {multiplier: 1, active: false})
  assert.deepEqual(relateDecision([-0.1, -0.1, ...Array<number>(58).fill(1)], config, active), {multiplier: 1.44, active: true})
  assert.deepEqual(relateDecision([1, ...Array<number>(59).fill(1)], config, active), {multiplier: 1, active: false})
})

test("Execution needs two positive recovery cohorts at the same entry-time loss step", () => {
  const [config] = generateStrategyCatalog("test", catalog)
  const settings = {...policy, activeStep: 2, recoveryMinTrades: 6}
  const samples = [-.1, -.1, ...Array<number>(58).fill(1)]
  const good: RelateTrial[] = [[15,2,-.2,1.44],[14,2,1,1.44],[13,2,1,1.44],[12,2,1,1.44],[11,2,1,1.44],[10,2,-.2,1.44]]
  const decide = (trials: RelateTrial[], before = 16, since = 10, stageMinPF = 1.25) =>
    relateExecution(samples,config,settings,60,{trials,before,since,stageMinPF},() => undefined)
  assert.equal(decide(good).multiplier,1.44)
  assert.equal(decide(good).active,true)
  assert.equal(decide(good,15).active,false, "the same-clock result is unavailable")
  assert.equal(decide(good,16,11).active,false, "expired evidence stays out of the decision")
  assert.equal(decide(good,16,10,11).active,false, "Exec uses its own required PF")
  assert.equal(decide(good.map(([time, , value, size])=>[time,1,value,size])).active,false, "another step is not a substitute")
  const losing: RelateTrial[] = good.map(([at,step,value,size]) => [at,step,at >= 13 ? -.2 : value,size])
  assert.equal(decide(losing).active,false, "a profitable aggregate can hide a losing recent cohort")
  const overstaked: RelateTrial[] = good.map(([at,step,value,size]) => [at,step,at === 15 ? -.9 : value,at === 15 ? 2 : size])
  assert.equal(decide(overstaked).active,false, "oversizing losses exceeds the drawdown limit")
})
