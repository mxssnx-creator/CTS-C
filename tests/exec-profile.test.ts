import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from "../core/engine"
import { EXEC_PROFILES, PROFILE_DCA_SIZING } from "../core/exec-profile"
import { generateEngineCatalog } from "../core/catalog"
import { ParentBranches } from "../core/stage-branches"
import { TerminalRuntime } from "../core/runtime"
import { StateStore } from "../core/store"
import type { Candle, ClosedTrade } from "../core/types"
import preset from "../research-data/exec-dca-trend-preset.json"

const symbols = ["UP-USDT","DOWN-USDT"]
const [trend,sar] = EXEC_PROFILES
const configured = { ...DEFAULT_ENGINE_SETTINGS, symbols, stageGateMode:"exec-branches" as const,
  catalog:{...DEFAULT_ENGINE_SETTINGS.catalog,strategyEnabledRanges:["Minimal"],strategyIndicationTypes:["Trend"],
    strategyTpSteps:[6],strategySlRatios:[1],strategyExitModes:["fixed"],
    strategyExecWindows:{base:{long:[20],short:[8],last:[2]},main:{long:["inherit"],short:[8],last:[2]},
      real:{long:["inherit"],short:[8],last:[2]},exec:{long:["inherit"],short:[20],last:[2]}},
    strategyStageCoordinations:{main:["block"],real:["block"],exec:["block"]}},
  symbolFees:{"DOWN-USDT":{makerFeePct:.02,takerFeePct:.06}},
}

test("recovery profiles retain signed Last-N branches across saved settings and use their own geometry",()=>{
  const profile = EXEC_PROFILES.find(profile=>profile.id==="trend-recovery-dca-v1")!
  const store=new StateStore(":memory:")
  const runtime=new TerminalRuntime("bingx-x02",store)
  let restored:TerminalRuntime|undefined
  try {
    runtime.saveFlatSettings({[profile.setting]:true})
    const settings=runtime.engine.settings
    const geometries=generateEngineCatalog(settings).filter(config=>config.execProfile===profile.id)
    assert.deepEqual(geometries.map(config=>[config.type,config.position_cost_step,config.tpStep,config.slRatio]),[["Trend_Efficiency",10,8,.8]])
    const plan=new ParentBranches(settings.catalog,true)
    const roots=plan.variants(geometries[0],undefined,"base")
    assert.equal(roots.length,8)
    assert.deepEqual(new Set(roots.map(config=>config.branch!.windows!.base!.long)),new Set([10,20]))
    const negative=roots.find(config=>config.branch!.windows!.base!.shortPolarity==="negative")!
    const main=plan.variants(negative,"dca","main"),real=plan.variants(main[0],"dca","real")
    const exec=plan.variants(real[0],"dca","exec")
    assert.equal(exec.length,12)
    assert.ok(exec.every(branch=>plan.restore(branch,geometries[0],coordination=>coordination==="dca")===branch))
    const sibling=generateEngineCatalog(settings).find(config=>config.execProfile===trend.id)!
    assert.ok(exec.every(branch=>plan.restore(branch,sibling,()=>true)===undefined))
    runtime.shutdown()
    restored=new TerminalRuntime("bingx-x02",store)
    assert.equal(restored.engine.settings.catalog[profile.setting],true)
    restored.saveFlatSettings({[profile.setting]:false})
    assert.ok(generateEngineCatalog(restored.engine.settings).every(config=>config.execProfile!==profile.id))
  } finally {restored?.shutdown();runtime.shutdown();store.close()}
})

function tape(sign:number): Candle[] {
  let price=100
  return Array.from({length:520},(_,index)=>{
    price *= 1+sign*(index%7===5?-.0035:.010)
    return {timestamp:1790000040000+60_000*index,open:price,high:price,low:price,close:price,volume:100}
  })
}

test("new and old Exec connections enable validated profiles and save independent opt-outs",()=>{
  const store=new StateStore(":memory:")
  const fresh=new TerminalRuntime("bingx-x02",store)
  const defaults=fresh.snapshot().settings
  for(const profile of EXEC_PROFILES)assert.equal(defaults[profile.setting],"true")
  assert.equal(fresh.engine.snapshot({laneLimit:0}).catalogCount,261)
  const sarGeometries=generateEngineCatalog(fresh.engine.settings).filter(config=>config.execProfile===sar.id)
  assert.deepEqual(sarGeometries.map(config=>config.indicationSourceId),[...sar.catalogs[0].strategyIndicationSources])
  assert.equal(new Set(sarGeometries.map(config=>config.id)).size,2)
  assert.equal(fresh.control.running,false)
  fresh.shutdown()
  const before=new TradingEngine(configured)
  store.saveEngineJSON(before.serializeState(),[],before.settings)
  const upgraded=new TerminalRuntime("bingx-x02",store)
  assert.equal(upgraded.snapshot().settings.strategyTrendDcaEnabled,"true")
  assert.deepEqual(upgraded.engine.settings.catalog.strategyExecWindows,configured.catalog.strategyExecWindows)
  assert.equal(upgraded.engine.settings.coordinations.dca.multiplier,2)
  upgraded.saveFlatSettings({strategyTrendDcaEnabled:false})
  upgraded.shutdown()
  const reopened=new TerminalRuntime("bingx-x02",store)
  assert.equal(reopened.snapshot().settings.strategyTrendDcaEnabled,"false")
  assert.equal(reopened.engine.snapshot({laneLimit:0}).catalogCount,before.snapshot({laneLimit:0}).catalogCount+8)
  reopened.saveFlatSettings({strategyTrendDcaEnabled:true,variantDcaEnabled:false})
  assert.equal(reopened.engine.snapshot({laneLimit:0}).catalogCount,before.snapshot({laneLimit:0}).catalogCount)
  reopened.saveFlatSettings({variantDcaEnabled:true})
  assert.equal(reopened.engine.snapshot({laneLimit:0}).catalogCount,before.snapshot({laneLimit:0}).catalogCount+9)
  reopened.shutdown();store.close()
})

test("default Trend + DCA reproduces the isolated profile across sides, fees and restart",()=>{
  const actual=new TradingEngine({...configured,catalog:{...configured.catalog,strategyTrendDcaEnabled:true}})
  const db=new StateStore(":memory:")
  const isolated=new TerminalRuntime("bingx-x02",db)
  isolated.saveFlatSettings(preset)
  isolated.engine.updateSettings({symbols,symbolFees:configured.symbolFees})
  const expected:ClosedTrade[]=[], received:ClosedTrade[]=[]
  isolated.engine.observeStageCloses(trade=>expected.push(trade))
  actual.observeStageCloses(trade=>{if(trade.configId.includes(trend.id))received.push(trade)})
  for(const [i,symbol] of symbols.entries()){
    const rows=tape(i===0?1:-1)
    isolated.engine.processCandles(symbol,rows,{eventLimit:0})
    actual.processCandles(symbol,rows,{eventLimit:0,allowExecution:true})
  }
  const accepting=actual.snapshot().positions.find(p=>p.executed&&p.configId.includes(trend.id)&&p.addedSteps===0)!
  assert.ok(accepting)
  const direction=accepting.direction==="long"?1:-1
  const at=actual.lastProcessedAt(accepting.symbol)!+5000
  for (const engine of [actual,isolated.engine]) {
    engine.processTick(accepting.symbol,accepting.lastAddPrice*(1-direction*.0035),at)
    engine.processTick(accepting.symbol,accepting.lastAddPrice*(1+direction*.025),at+5000)
  }
  const result=(t:ClosedTrade)=>[t.configId.replace(`.${trend.id}`,""),t.symbol,t.stage,t.coordination,t.direction,
    t.openedAt,t.closedAt,t.entryPrice,t.exitPrice,t.quantity,t.cost,t.netReturnPct,t.fills,t.executed,Boolean(t.progressionProof)]
  assert.deepEqual(received.map(result),expected.map(result))
  const accepted=received.filter(t=>t.executed)
  assert.ok(accepted.some(t=>t.direction==="long")&&accepted.some(t=>t.direction==="short"))
  assert.ok(accepted.some(t=>t.fills.some(fill=>fill.kind==="dca")))
  assert.equal(accepted.length,received.filter(t=>t.stage==="live").length)
  assert.equal(actual.snapshot().stages.find(s=>s.stage==="exec")!.execProfiles![trend.id]!.closed,accepted.length)
  const profileLanes=actual.snapshot().lanes.filter(lane=>lane.configId.includes(trend.id))
  assert.ok(profileLanes.filter(lane=>lane.stage!=="base").every(lane=>lane.coordination==="dca"))
  assert.ok(Object.values(actual.exportState().lanes).some(lane=>!lane.configId.includes(trend.id)))
  const restored=TradingEngine.fromSerialized(actual.serializeState())
  assert.deepEqual(restored.snapshot(),actual.snapshot())
  const ids=profileLanes.map(lane=>lane.id)
  restored.updateSettings({coordinations:{...configured.coordinations,dca:{...configured.coordinations.dca,distancePct:2,multiplier:3}}})
  assert.ok(restored.snapshot().lanes.filter(lane=>ids.includes(lane.id)).every(lane=>lane.current))
  assert.ok(restored.snapshot().positions.filter(p=>p.configId.includes(trend.id)).every(p=>p.sizing!.dca.distancePct===PROFILE_DCA_SIZING.distancePct))
  const disable={...restored.settings.catalog,strategyTrendDcaEnabled:false}
  restored.updateSettings({catalog:disable})
  assert.ok(restored.snapshot().lanes.filter(lane=>ids.includes(lane.id)).every(lane=>!lane.current))
  for (const position of restored.snapshot().positions.filter(p=>p.configId.includes(trend.id))) {
    assert.equal(restored.isLiveIntentEligible(position.id),false)
  }
  isolated.shutdown();db.close()
})
