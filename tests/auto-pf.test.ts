import assert from "node:assert/strict"
import { test } from "node:test"
import { AUTO_PF_DEFAULTS, autoPfMinimum } from "../core/auto-pf"
import { generateStrategyCatalog } from "../core/catalog"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine, windowMetrics } from "../core/engine"
import { DEFAULTS, flatEngineSettings, hydrate, validateConfiguration } from "../core/settings-schema"
import { StateStore } from "../core/store"
import type { Candle, ClosedTrade } from "../core/types"

const catalog = {
  ...AUTO_PF_DEFAULTS, autoPfMinSamples:3, autoPfHistory:6, autoPfAdjustment:1,
  strategyTpSteps:[3], strategySlRatios:[1], strategyExitModes:["fixed"], strategyIndicationTypes:["Trend"], strategySignalPeriods:[10],
}

test("Auto PF raises an exact Set's floor from its own older dated returns", () => {
  const [config] = generateStrategyCatalog("test",catalog)
  const policy = config.autoPfPolicy!
  const evaluate = (samples:number[],timedSampleCount=samples.length) => windowMetrics({config,samples,closedCount:samples.length,timedSampleCount},2,1.05)
  const recent = [1.2,-1]
  const good = evaluate([...recent,1,1,-1])
  const weak = evaluate([...recent,.1,-1,-.5])
  assert.equal(good.minPF,policy.fallback)
  assert.equal(good.qualified,true)
  assert.equal(weak.minPF,policy.cap)
  assert.equal(weak.qualified,false)
  assert.equal(weak.profitFactor,good.profitFactor)
  assert.deepEqual(weak.autoPf,{mode:"set-history",samples:3,profit:.1,loss:1.5})
  assert.deepEqual(evaluate([...recent,.1,-1,-.5],4).autoPf,{mode:"fallback",samples:2})
  assert.equal(evaluate([1]).enoughSamples,false)
  assert.equal(evaluate([NaN,1,1,1,1]).qualified,false)
  assert.equal(windowMetrics({config,samples:recent,closedCount:2},2,1.4).minPF,1.4)
})

test("legacy TP-based settings and new Auto PF settings round trip independently", () => {
  const old:Record<string,unknown> = {...DEFAULTS,autoPfEnabled:true}
  for (const key of ["autoPfMode","autoPfFallback","autoPfMinSamples","autoPfHistory","autoPfAdjustment"]) delete old[key]
  assert.equal(validateConfiguration(old).autoPfMode,"tp-distance")
  assert.equal(hydrate({autoPfEnabled:"true",autoPfRatio:"0.5"}).autoPfMode,"tp-distance")
  assert.equal(hydrate({}).autoPfEnabled,true)
  assert.throws(()=>validateConfiguration({...DEFAULTS,autoPfMinSamples:9,autoPfHistory:8}),/Auto PF/)
  assert.throws(()=>validateConfiguration({...DEFAULTS,autoPfFallback:2,autoPfMax:1.5}),/Auto PF/)
  const legacyEngine = new TradingEngine({catalog:{autoPfEnabled:true,strategyTpSteps:[3],strategySlRatios:[1]}})
  assert.equal(flatEngineSettings(legacyEngine.settings,{historyCandles:4320,symbolCount:3}).autoPfMode,"tp-distance")
  assert.equal(legacyEngine.settings.catalog.autoPfMode,undefined)
})

test("Auto PF provenance survives checkpoint restart and children need fresh proofs after a parent dip", () => {
  const symbol = "BTC-USDT"
  const engine = new TradingEngine({
    symbols:[symbol],stageGateMode:"exec-branches",execMinPF:1.15,
    catalog:{...catalog,strategyExecWindows:{base:{long:[10],short:[4],last:[1]},
      main:{long:["none"],short:[4],last:[1]},real:{long:["none"],short:[4],last:[1]},exec:{long:["none"],short:[4],last:[1]}}},
    coordinations:{
      axis:{...DEFAULT_ENGINE_SETTINGS.coordinations.axis,enabled:false},
      block:{...DEFAULT_ENGINE_SETTINGS.coordinations.block,enabled:false},
      dca:{...DEFAULT_ENGINE_SETTINGS.coordinations.dca,enabled:false},
    },
  })
  const bar = (index:number,close:number):Candle => ({timestamp:1790000040000+index*60_000,open:close,high:close,low:close,close,volume:1})
  const closes:ClosedTrade[] = []
  engine.observeStageCloses(trade=>closes.push(trade))
  const run = Array.from({length:111},(_,i)=>bar(i,100*1.006**i))
  engine.processCandles(symbol,run,{eventLimit:0})
  const executed = closes.filter(trade=>trade.executed)
  assert.ok(executed.length>10)
  assert.ok(executed.some(trade=>trade.executionProof?.autoPf?.mode === "fallback"))
  assert.ok(executed.every(trade=>trade.executionProof?.stage==="exec"&&trade.executionProof.checkedAt===trade.openedAt&&trade.executionProof.minPF>=1.15))
  for (const [index,floor] of [1.1,1.1,1.1].entries()) {
    const proof = executed.find(trade=>trade.admission?.[index].autoPf?.mode==="set-history")!.admission![index]
    const lane = engine.snapshot().lanes.find(lane=>lane.id===proof.laneId)!
    assert.ok(lane.autoPf)
    assert.equal(proof.minPF,Math.max(floor,autoPfMinimum(generateStrategyCatalog("test",catalog)[0].autoPfPolicy,proof.autoPf)))
  }
  const store = new StateStore(":memory:")
  try {
    store.migrateLaneCheckpoint(engine.checkpointMetadata(),engine.checkpointLanes(true),[],engine.settings,()=>{})
    const restored = TradingEngine.fromOwnedCheckpoint(store.loadEngineState()!)
    assert.deepEqual(restored.snapshot(),engine.snapshot())
    const dip = run.at(-1)!.close*.982
    const originalOpen = new Set(engine.snapshot().positions.filter(position=>position.executed).map(position=>position.id))
    assert.ok(originalOpen.size)
    const observed = engine.processTick(symbol,dip,run.at(-1)!.timestamp+10000)
    const actual = observed.find(event=>event.trade?.executed)!.trade!
    assert.ok(originalOpen.has(actual.id))
    assert.ok(actual.netReturnPct<0)
    assert.deepEqual(restored.processTick(symbol,dip,run.at(-1)!.timestamp+10000),observed)
    const afterDip = bar(111,dip*1.004)
    const events = engine.processCandles(symbol,[afterDip])
    assert.deepEqual(restored.processCandles(symbol,[afterDip]),events)
    assert.ok(events.some(event=>event.type==="opened"&&event.stage==="base"))
    assert.ok(!events.some(event=>event.type==="opened"&&event.stage!=="base"))
  } finally { store.close() }
})
