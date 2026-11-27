import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine, windowMetrics } from "../core/engine"
import { checkExecWindows, DEFAULT_EXEC_WINDOWS, execBlockPolicy, execPathCount } from "../core/last-n-grid"
import { StateStore } from "../core/store"
import type { Candle, EngineSettings, ClosedTrade } from "../core/types"
import { blockPrefix, evaluateBlocks } from "../shared/cts-lastn/blocks"
import { BRANCH_COORDINATIONS, ParentBranches } from "../core/stage-branches"
import { generateStrategyCatalog } from "../core/catalog"
import { runExecProgressionReplay } from "../core/terminal-replay"
import { describeProfitFactor } from "../core/metrics"
import { DEFAULTS, hydrate, validateConfiguration } from "../core/settings-schema"

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

test("positive and negative outcomes make independent paths and preserve the full-window PF", () => {
  const outcomes = ["positive","negative"] as const
  const late = {long:["inherit"],short:[30],last:[1],shortOutcomes:outcomes,lastOutcomes:outcomes}
  const windows = checkExecWindows({base:{long:[10],short:[4,16],last:[1],shortOutcomes:outcomes,lastOutcomes:outcomes},
    main:{long:["none","inherit"],short:[4],last:[1],shortOutcomes:outcomes,lastOutcomes:outcomes},real:late,exec:late})
  const plan = new ParentBranches({strategyExecWindows:windows},true)
  const config = generateStrategyCatalog("test",settings.catalog)[0]
  const base = plan.variants(config,undefined,"base")
  assert.equal(base.length,8)
  assert.equal(new Set(base.map(lane=>lane.id)).size,8)
  assert.equal(base.filter(lane=>lane.branch?.windows?.base?.shortPolarity==="negative").length,4)
  const parent = base.find(lane=>lane.branch?.windows?.base?.minimalPolarity==="negative")!
  const next = plan.variants(parent,"normal","main")
  assert.equal(next.length,8)
  for (const child of next) assert.equal(plan.restore(child,config,()=>true),child)
  const real = plan.variants(next[0],"normal","real")
  assert.equal(real.length,4)
  const exec = real.flatMap(lane=>["normal","axis"].flatMap(coordination=>plan.variants(lane,coordination as "normal"|"axis","exec")))
  assert.equal(exec.length,32)
  assert.equal(new Set(exec.map(lane=>lane.id)).size,32)
  for (const lane of exec) {
    assert.equal(plan.restore(lane,config,()=>true),lane)
    assert.equal(lane.branch!.windows!.exec!.short,30)
  }
  const losses = blockPrefix([...Array<number>(31).fill(-.01),...Array<number>(10).fill(.05)])
  assert.equal(evaluateBlocks(losses,execBlockPolicy(10,30,1,"negative","negative"),1.1).state,"qualified")
  assert.equal(evaluateBlocks(losses,execBlockPolicy(0,30,1,"negative","negative"),1.1).state,"failed")
  const negative = execBlockPolicy(0,4,1,"positive","negative")
  assert.equal(evaluateBlocks(blockPrefix([-.2,.2,.2,.2,.2]),negative,1.1).state,"qualified")
  assert.equal(evaluateBlocks(blockPrefix([-1,.2,.2,.2,.2]),negative,1.1).state,"failed")
})

test("Base materializes geometry only when that window qualifies", () => {
  const initial=checkExecWindows(settings.catalog!.strategyExecWindows)
  const windows=checkExecWindows({...initial,base:{...initial.base,long:[10,50],shortOutcomes:["positive","negative"]}})
  const engine=new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:windows}})
  const plan=(engine as unknown as {branches:ParentBranches}).branches
  engine.processCandles(symbol,bars.slice(0,45),{eventLimit:0})
  const observation=Object.values(engine.exportState().lanes).find(lane=>lane.baseObservation&&lane.direction==="long")!
  const templates=plan.baseWindows(observation.config)
  assert.ok(plan.baseConfig(observation.config,templates[0]))
  assert.equal(plan.baseConfig(observation.config,templates[1]),undefined,"the negative Short did not qualify")
  assert.equal(plan.baseConfig(observation.config,templates[2]),undefined,"the long window needs more closes")
  engine.processCandles(symbol,bars.slice(45),{eventLimit:0})
  assert.ok(plan.baseConfig(observation.config,templates[2]),"the longer Set is created once its own gate passes")
})

test("a restored Base Set progresses while its observation is still rebuilding history", () => {
  const engine = new TradingEngine(settings)
  const index = 130
  engine.processCandles(symbol,bars.slice(0,index),{eventLimit:0})
  const state = engine.exportState()
  const base = Object.values(state.lanes).find(lane=>lane.stage==="base"&&!lane.baseObservation&&lane.direction==="long")!
  assert.ok(base.samples.length>=15)
  for (const lane of Object.values(state.lanes)) if (lane.baseObservation) delete state.lanes[lane.id]
  const restored = TradingEngine.fromOwnedCheckpoint(state)
  const admitted = []
  for (const bar of bars.slice(index,index+6)) {
    admitted.push(...restored.processCandles(symbol,[bar]).filter(event=>event.type==="opened"))
  }
  assert.ok(admitted.some(event=>event.laneId===base.id))
  assert.ok(admitted.some(event=>event.stage==="live"))
  const probe = Object.values(restored.exportState().lanes).find(lane=>lane.baseObservation&&lane.direction==="long")!
  assert.ok(probe.samples.length<15)
})

test("additional signals reuse an unchanged Base observation", (t) => {
  const engine = new TradingEngine(settings)
  const rising = Array.from({length:20},(_,i)=>{
    const close = 100*1.00001**i
    return {...makeBar(i),open:close,high:close,low:close,close}
  })
  engine.processCandles(symbol,rising.slice(0,12))
  const before = Object.values(engine.exportState().lanes).find(lane=>lane.baseObservation)!
  assert.ok(before.open)
  const cache = t.mock.method(engine as unknown as {cacheLane:()=>void},"cacheLane")
  engine.processCandles(symbol,rising.slice(12))
  const after = engine.exportState().lanes[before.id]
  assert.equal(after.open!.id,before.open.id)
  assert.equal(cache.mock.callCount(),0,"no identity or registration work for the open probe")
})

test("funding one Exec sibling retains all exact Set samples and mirrors a complete proof after restart", () => {
  const limitedCatalog = {...settings.catalog,strategyExecSingleEntry:true}
  assert.equal(validateConfiguration({strategyExecSingleEntry:true},{partial:true}).strategyExecSingleEntry,true)
  assert.equal(hydrate({strategyExecSingleEntry:"true"}).strategyExecSingleEntry,true)
  assert.equal(validateConfiguration(DEFAULTS).strategyExecSingleEntry,false)
  assert.throws(()=>new TradingEngine({...settings,catalog:{...limitedCatalog,strategyExecSingleEntry:"true"}}),/Exec single entry/)

  const all = new TradingEngine(settings)
  const limited = new TradingEngine({...settings,catalog:limitedCatalog})
  const closing: Record<"all"|"limited",ClosedTrade[]> = {all:[],limited:[]}
  all.observeStageCloses(trade=>closing.all.push(trade))
  limited.observeStageCloses(trade=>closing.limited.push(trade))
  for (const engine of [all,limited]) engine.processCandles(symbol,bars.slice(0,166),{eventLimit:0})
  const reloaded = TradingEngine.fromSerialized(limited.serializeState())
  reloaded.observeStageCloses(trade=>closing.limited.push(trade))
  all.processCandles(symbol,bars.slice(166),{allowExecution:true,eventLimit:0})
  reloaded.processCandles(symbol,bars.slice(165),{allowExecution:true,eventLimit:0})
  const execBook = (book:ClosedTrade[])=>book.filter(trade=>trade.stage==="exec")
    .map(trade=>[trade.id,trade.openedAt,trade.closedAt,trade.netReturnPct,trade.netPnl,trade.admission])
  assert.deepEqual(execBook(closing.limited),execBook(closing.all),"all Exec Sets still maintain their own close and gate history")
  const potential = closing.all.filter(trade=>trade.executed)
  const mirrored = closing.limited.filter(trade=>trade.executed)
  assert.ok(mirrored.length>0 && mirrored.length<potential.length)
  assert.equal(mirrored.length,new Set(mirrored.map(trade=>trade.openedAt)).size)
  assert.equal(mirrored.length,new Set(potential.map(trade=>trade.openedAt)).size)
  for (const trade of mirrored) {
    const available = potential.filter(candidate=>candidate.openedAt===trade.openedAt)
    assert.equal(trade.executionProof!.count,Math.max(...available.map(candidate=>candidate.executionProof!.count)))
    const live = closing.limited.find(candidate=>candidate.stage==="live"&&candidate.parentPositionId===trade.id)
    assert.equal(live?.netPnl,trade.netPnl)
    assert.deepEqual(live?.admission,[...trade.admission!,trade.executionProof])
  }
  const intents = reloaded.pendingIntents().filter(intent=>intent.kind==="entry")
  assert.ok(intents.length>0)
  assert.equal(intents.length,new Set(intents.map(intent=>intent.timestamp)).size)
})

test("post-stage cash PF uses funded settled P&L and preserves legacy coverage", () => {
  const other = "ETH-USDT"
  const engine = new TradingEngine({...settings,symbols:[symbol,other],catalog:{
    ...settings.catalog,relationalVolumeRatios:{symbols:{[other]:4}},
  }})
  const trades:ClosedTrade[] = []
  engine.observeStageCloses(trade=>trades.push(trade))
  let index = 110
  for (const asset of [symbol,other]) engine.processCandles(asset,bars.slice(0,index),{eventLimit:0})
  let open = engine.snapshot({positionStage:"exec"}).positions.filter(position=>position.executed)
  while (!open.length && index<bars.length) {
    for (const asset of [symbol,other]) engine.processCandles(asset,[bars[index]],{eventLimit:0})
    index++
    open = engine.snapshot({positionStage:"exec"}).positions.filter(position=>position.executed)
  }
  const legacy = engine.exportState()
  for (const lane of Object.values(legacy.lanes)) for (const cohort of [lane.executed,lane.postStage]) {
    if (!cohort) continue
    delete cohort.cashClosed
    delete cohort.cashProfit
    delete cohort.cashLoss
  }
  const restored = TradingEngine.fromOwnedCheckpoint(legacy)
  const exec = (candidate:TradingEngine) => candidate.snapshot({laneLimit:0,positionLimit:0}).stages.find(row=>row.stage==="exec")!.executed!
  assert.ok(exec(restored).closed>0)
  assert.deepEqual(exec(restored).cashPF,{samples:0,profitFactor:null,pfState:"unknown"})
  const newCloses:ClosedTrade[] = []
  restored.observeStageCloses(trade=>newCloses.push(trade))
  for (const [asset,move] of [[symbol,1.012],[other,.988]] as const) {
    const position = open.find(row=>row.symbol===asset)!
    const tick = position.entryPrice*move, time = bars[index-1].timestamp+1_000
    for (const candidate of [engine,restored]) candidate.processTick(asset,tick,time)
  }
  const cash = (rows:ClosedTrade[]) => {
    const accepted = rows.filter(trade=>trade.executed)
    const gains = accepted.reduce((total,trade)=>total+Math.max(0,trade.netPnl),0)
    const losses = accepted.reduce((total,trade)=>total+Math.max(0,-trade.netPnl),0)
    assert.ok(gains>0&&losses>0)
    return {samples:accepted.length,...describeProfitFactor(gains,losses,accepted.length)}
  }
  const total = exec(engine)
  assert.equal(total.cashPF!.samples,total.closed)
  assert.ok(Math.abs(total.cashPF!.profitFactor!-cash(trades).profitFactor)<1e-10)
  assert.notEqual(total.profitFactor,total.cashPF!.profitFactor)
  const mixed = exec(restored)
  assert.equal(mixed.cashPF!.samples,cash(newCloses).samples)
  assert.ok(Math.abs(mixed.cashPF!.profitFactor!-cash(newCloses).profitFactor)<1e-10)
  assert.equal(mixed.closed,total.closed)
  assert.deepEqual(exec(TradingEngine.fromSerialized(restored.serializeState())),mixed)
})

test("dashboard reuses stage totals for marks and refreshes them on settlement and settings changes", (t) => {
  const engine=new TradingEngine(settings)
  let end=130
  engine.processCandles(symbol,bars.slice(0,end),{eventLimit:0,allowExecution:true})
  while(!engine.snapshot().positions.some(position=>position.stage==="live")&&end<bars.length){
    engine.processCandles(symbol,[bars[end++]],{eventLimit:0,allowExecution:true})
  }
  const display={laneLimit:100,positionLimit:100,positionStage:"live" as const}
  const mock=t.mock.method(engine as unknown as {stageWindow:()=>unknown},"stageWindow")
  const read=()=>engine.snapshot({...display,includeCoordinationStats:true})
  const first=read()
  const calls=mock.mock.callCount()
  assert.ok(calls>0)
  const live=first.positions[0]
  assert.ok(live)
  engine.processTick(symbol,live.entryPrice*1.00001,bars[end-1].timestamp+1000)
  const marked=read()
  assert.equal(mock.mock.callCount(),calls,"price-only marks do not rescan stage books")
  assert.deepEqual(marked.stages,first.stages)
  assert.ok(marked.positions.find(position=>position.id===live.id)!.peak>live.peak)
  marked.stages[0].closed=-1
  assert.deepEqual(read().stages,first.stages,"returned reports cannot mutate the cache")

  engine.processTick(symbol,live.entryPrice*1.1,bars[end-1].timestamp+2000)
  const settled=read()
  assert.ok(mock.mock.callCount()>calls)
  assert.ok(settled.stages.find(stage=>stage.stage==="live")!.closed>first.stages.find(stage=>stage.stage==="live")!.closed)
  const {coordinationStats,...standard}=settled
  assert.deepEqual(standard,engine.snapshot(display))
  assert.deepEqual(coordinationStats,engine.coordinationStats())
  engine.updateSettings({stageMinPF:{base:1.5,main:1.5,real:1.5}})
  const {coordinationStats:reported,...updated}=read()
  assert.deepEqual(updated,engine.snapshot(display))
  assert.deepEqual(reported,engine.coordinationStats())
})

test("bounded recent closes keep exact newest-first order through a rollover and restart",()=>{
  const engine=new TradingEngine(settings)
  const reference:string[]=[]
  engine.observeStageCloses(trade=>reference.push(trade.id))
  engine.processCandles(symbol,Array.from({length:360},(_,i)=>makeBar(i)),{eventLimit:0})
  assert.ok(reference.length>1000)
  assert.deepEqual(engine.snapshot({laneLimit:0}).trades.map(trade=>trade.id),reference.slice(-1000).reverse())

  const restored=TradingEngine.fromSerialized(engine.serializeState())
  restored.observeStageCloses(trade=>reference.push(trade.id))
  restored.processCandles(symbol,Array.from({length:12},(_,i)=>makeBar(360+i)),{eventLimit:0})
  assert.deepEqual(restored.snapshot({laneLimit:0}).trades.map(trade=>trade.id),reference.slice(-1000).reverse())
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
    assert.deepEqual(byStage.postStage,byStage.executed)
    for (const row of checkpoint.stages.slice(0,3)) {
      const parentIds = new Set([...observed.values()].filter(trade=>trade.admission?.at(-1)?.stage===row.stage).map(trade=>trade.parentPositionId))
      const parents = [...observed.values()].filter(trade=>trade.stage===row.stage&&trade.progressionProof)
      assert.ok(parents.length>0)
      assert.ok(parents.every(trade=>parentIds.has(trade.id)))
      assert.equal(row.postStage!.closed,parents.length,"one settled parent counts once across all sibling admissions")
      assert.equal(row.postStage!.pfState,"no-losses")
    }
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
        assert.deepEqual(parentTrade.executionProof,trade.admission!.at(-1))
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

test("Real and Exec can select Short up to 30 and each width uses its own complete window", () => {
  const initial = checkExecWindows(settings.catalog!.strategyExecWindows)
  const exec = {...initial.exec,short:[30,20,28,24]}
  const windows = checkExecWindows({...initial,real:{...initial.real,short:[30]},exec})
  assert.deepEqual(windows.real.short,[30])
  assert.deepEqual(windows.exec.short,[20,24,28,30])
  assert.deepEqual(checkExecWindows({real:{short:[30]}}).real.short,[30])
  assert.throws(()=>checkExecWindows({main:{short:[30]}}),/distinct Exec window choices/)
  assert.throws(()=>checkExecWindows({...initial,exec:{...exec,short:[31]}}),/distinct Exec window choices/)
  assert.throws(()=>checkExecWindows({...initial,exec},50),/exceed retained/)
  const minimal = {long:["none"],short:[4,30],last:[1],shortOutcomes:["negative"]}
  assert.throws(()=>checkExecWindows({...initial,exec:minimal},25),/Exec exec windows exceed retained samples/)
  assert.doesNotThrow(()=>checkExecWindows({...initial,exec:minimal},31))
  const engine = new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:windows}})
  const traded:ClosedTrade[]=[]
  engine.observeStageCloses(trade=>{if(trade.executed) traded.push(trade)})
  engine.processCandles(symbol,bars,{allowExecution:true,eventLimit:0})
  const closings = [...new Set(traded.map(trade=>trade.executionProof?.required))].sort((a,b)=>a!-b!)
  assert.ok(closings.includes(31),"30 Short closes plus one Last close are needed for the no-Long variant")
  assert.ok(closings.includes(41),"the inherited Base Long contributes ten more disjoint closes")
  assert.ok(traded.every(trade=>trade.executionProof!.count===trade.executionProof!.required))
  assert.ok(traded.every(trade=>trade.admission?.some(proof=>proof.stage==="real"&&proof.required===31&&proof.count===31)))
})

test("wide signed Real and Exec Sets keep their own parent, inherited Long and exact window", () => {
  const signed = {long:["none","inherit"],short:[30],last:[1],shortOutcomes:["positive","negative"],lastOutcomes:["positive","negative"]}
  const windows = checkExecWindows({base:{long:[10],short:[4],last:[1]},main:{long:["none"],short:[4],last:[1]},real:signed,exec:signed})
  const catalog = {strategyExecWindows:windows}
  const plan = new ParentBranches(catalog,true)
  const geometry = generateStrategyCatalog("test",settings.catalog)[0]
  const [base] = plan.variants(geometry,undefined,"base")
  const [main] = plan.variants(base,"normal","main")
  const real = plan.variants(main,"normal","real")
  const exec = real.flatMap(parent=>plan.variants(parent,"normal","exec"))
  assert.equal(real.length,8)
  assert.equal(new Set(exec.map(config=>config.id)).size,64)
  assert.equal(exec.length,execPathCount(windows))
  const restoredPlan=new ParentBranches(catalog,true)
  assert.deepEqual(exec.map(config=>restoredPlan.restore(config,geometry,()=>true)),exec)

  const returns = [-.05,...Array<number>(30).fill(-.02),...Array<number>(10).fill(.2)]
  for(const stage of ["real","exec"] as const){
    const configs=stage==="real"?real:plan.variants(real[0],"normal","exec")
    const qualified=configs.filter(config=>evaluateBlocks(blockPrefix(returns),config.branch!.windows![stage]!,1.1).state==="qualified")
    assert.equal(qualified.length,1)
    const policy=qualified[0].branch!.windows![stage]!
    assert.deepEqual(policy,execBlockPolicy(10,30,1,"negative","negative"))
    assert.equal(evaluateBlocks(blockPrefix(returns.slice(0,-1)),policy,1.1).state,"insufficient")
    assert.equal(evaluateBlocks(blockPrefix(returns),policy,4).state,"failed")
  }
})

test("both negative outcomes reach Exec through owned positions and complete gates at every stage", () => {
  const outcomes = ["positive","negative"]
  const next = {long:["inherit"],short:[4],last:[1],shortOutcomes:outcomes,lastOutcomes:outcomes}
  const windows = checkExecWindows({base:{...next,long:[10]},main:next,real:next,exec:next})
  const engine = new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:windows}})
  const support = new Map<string,Set<string>>()
  engine.observeStageCloses(trade=>{
    if (!trade.executed) return
    const gates = [...trade.admission!,trade.executionProof!]
    assert.deepEqual(gates.map(gate=>gate.stage),["base","main","real","exec"])
    assert.equal(new Set(gates.map(gate=>gate.laneId)).size,4)
    for (const gate of gates) {
      const [,long,short,last,shortOutcome,lastOutcome] = JSON.parse(gate.blockPolicyKey!)
      assert.deepEqual([long,short,last,gate.required,gate.count],[10,4,1,15,15])
      assert.equal(gate.checkedAt,trade.openedAt)
      assert.ok(gate.qualified&&gate.profitFactor!>=gate.minPF)
      const pairs = support.get(gate.stage) ?? new Set<string>()
      pairs.add(`${shortOutcome}/${lastOutcome}`)
      support.set(gate.stage,pairs)
    }
  })
  let seed = 113
  for (let i=0; i<1_800; i++) {
    seed = (Math.imul(seed,1_664_525)+1_013_904_223)>>>0
    const close = 100*1.003**i, timestamp = 1_790_000_040_000+i*60_000
    engine.processCandles(symbol,[{timestamp,open:close,high:close,low:close,close,volume:100}],{eventLimit:0})
    engine.processTick(symbol,close*(seed/2**32<.35?.996:1.01),timestamp+1_000)
  }
  for (const stage of ["base","main","real","exec"]) {
    assert.ok([...support.get(stage)!].some(pair=>pair.startsWith("negative/")),stage)
    assert.ok([...support.get(stage)!].some(pair=>pair.endsWith("/negative")),stage)
  }
  assert.ok(support.get("exec")!.has("negative/negative"))
  const {stages} = engine.snapshot({laneLimit:0,positionLimit:0})
  assert.equal(stages.find(stage=>stage.stage==="exec")!.executed!.closed,stages.find(stage=>stage.stage==="live")!.closed)
})

test("terminal holdout reports only the settled positions that fed a child", async () => {
  const windows = checkExecWindows(settings.catalog!.strategyExecWindows)
  const engine = new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:{...windows,exec:{...windows.exec,short:[4,30]}}}})
  const input = bars.map(({timestamp,...candle})=>({...candle,time:timestamp/1000-60}))
  const holdout = await runExecProgressionReplay(symbol,input,engine.settings)
  const byStage = Object.fromEntries(holdout.map(row=>[row.stage,row]))
  assert.ok(byStage.base.postStage!.closed>0)
  assert.ok(byStage.real.postStage!.closed>0)
  assert.ok(byStage.exec.postStage!.closed>0)
  assert.ok(byStage.exec.postStage!.closed<byStage.exec.closed)
  assert.equal(byStage.exec.postStage!.closed,byStage.executed.closed)
  assert.equal(byStage.exec.postStage!.profitFactor,byStage.live.profitFactor)
  assert.equal(byStage.live.postStage,undefined)
  const [trend] = byStage.executed.indications!
  assert.equal(trend.source,"Trend")
  assert.equal(trend.execCloses,byStage.exec.closed)
  assert.equal(trend.closed,byStage.executed.closed)
  assert.equal(trend.profitFactor,byStage.live.profitFactor)
})

test("Exec eligibility verifies the complete opening receipt restored with the matching Exec position", () => {
  const engine = new TradingEngine(settings)
  engine.processCandles(symbol,bars.slice(0,-1),{allowExecution:true,eventLimit:0})
  const state = engine.exportState()
  const live = Object.values(state.lanes).find(lane=>lane.stage==="live"&&lane.open?.executionEligible)!
  assert.ok(live)
  assert.ok(TradingEngine.fromOwnedCheckpoint(structuredClone(state)).isLiveIntentEligible(live.open!.id))
  const stale = structuredClone(state)
  stale.lanes[live.id].open!.admission![0].checkedAt -= 60_000
  assert.equal(TradingEngine.fromOwnedCheckpoint(stale).isLiveIntentEligible(live.open!.id),false)
  const invalid = live.open!.admission!.at(-1)!
  invalid.profitFactor = invalid.minPF-.01
  state.lanes[invalid.laneId].open!.executionProof = {...invalid}
  assert.equal(TradingEngine.fromOwnedCheckpoint(state).isLiveIntentEligible(live.open!.id),false)
})

test("cross-coordination stages retain the exact Base origin and their own step results", () => {
  const defaults = DEFAULT_ENGINE_SETTINGS.coordinations
  const setup:Partial<EngineSettings> = {...settings,
    coordinations:{...defaults,axis:{...defaults.axis,previous:4,last:1,reference:"same-stage"}},
    catalog:{...settings.catalog,strategyStageCoordinations:{main:["axis"],real:["block"],exec:["dca"]},strategyExecWindows:{
      base:{long:[10],short:[4],last:[1]},main:{long:["none"],short:[4],last:[1]},real:{long:["none"],short:[4],last:[1]},exec:{long:["none"],short:[4],last:[1]},
    }},
  }
  const engine = new TradingEngine(setup)
  const settled:ClosedTrade[]=[]
  engine.observeStageCloses(trade=>settled.push(trade))
  engine.processCandles(symbol,bars,{eventLimit:0})
  const state = engine.exportState()
  const executed = settled.filter(trade=>trade.executed)
  assert.ok(executed.length>0)
  for (const trade of executed) {
    const owners=trade.admission!.map(proof=>state.lanes[proof.laneId])
    assert.equal(owners[1].coordination,"axis")
    assert.equal(owners[2].coordination,"block")
    assert.equal(trade.coordination,"dca")
    assert.ok(owners.every(owner=>owner.symbol===trade.symbol&&owner.direction===trade.direction))
    assert.ok(owners.every(owner=>owner.config.branch!.geometryId===state.lanes[trade.laneId].config.branch!.geometryId))
    assert.ok(trade.admission!.every(proof=>proof.checkedAt===trade.openedAt))
  }
  assert.deepEqual(TradingEngine.fromOwnedCheckpoint(state).snapshot(),engine.snapshot())
})

test("Base coordinator selection keeps the hidden Axis probe and retires excluded origins", () => {
  const defaults = DEFAULT_ENGINE_SETTINGS.coordinations
  const selections = {base:["axis"],main:["normal"],real:["normal"],exec:["normal"]}
  const next = {long:["none"],short:[4],last:[1]}
  const engine = new TradingEngine({...settings,coordinations:{
    ...settings.coordinations!,
    axis:{...defaults.axis,enabled:true,previous:4,last:1,reference:"base"},
  },catalog:{...settings.catalog,strategyStageCoordinations:selections,strategyExecWindows:{
    base:{...next,long:[10]},main:next,real:next,exec:next,
  }}})
  const accepted:ClosedTrade[] = []
  engine.observeStageCloses(trade=>{if(trade.executed)accepted.push(trade)})
  engine.processCandles(symbol,bars,{eventLimit:0})
  assert.ok(accepted.length>0)
  const state = engine.exportState(), base = Object.values(state.lanes).filter(lane=>lane.stage==="base")
  assert.ok(base.some(lane=>lane.coordination==="normal"&&lane.baseObservation&&lane.calculationOnly))
  assert.ok(base.every(lane=>lane.baseObservation||lane.coordination==="axis"))
  assert.deepEqual(engine.snapshot().stages[0].baseCandidates,{observed:1,enoughSamples:1})
  assert.ok(accepted.every(trade=>state.lanes[trade.admission![0].laneId].coordination==="axis"))
  const restored = TradingEngine.fromOwnedCheckpoint(state)
  assert.deepEqual(restored.snapshot(),engine.snapshot())
  const catalog = restored.settings.catalog
  restored.updateSettings({catalog:{...catalog,strategyStageCoordinations:{...selections,base:["normal"]}}})
  assert.ok(restored.snapshot({laneLimit:Infinity}).lanes.every(lane=>!lane.current))
  const timestamp = bars.at(-1)!.timestamp + 60_000
  restored.processCandles(symbol,[{...makeBar(202),timestamp}],{allowExecution:true})
  assert.equal(restored.pendingIntents().length,0,"a retired Axis branch cannot emit a new exchange intent")
})

test("each enabled coordination and chosen Short size forms a separately qualified Exec path", () => {
  const windows = checkExecWindows({
    base:{long:[10],short:[4],last:[1]},main:{long:["none"],short:[4],last:[1]},
    real:{long:["none"],short:[4],last:[1]},exec:{long:["none"],short:[4,8],last:[1]},
  })
  const defaults = DEFAULT_ENGINE_SETTINGS.coordinations
  const engine = new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:windows},
    coordinations:{...defaults,axis:{...defaults.axis,previous:4,last:1,reference:"same-stage"},relate:{...defaults.relate!,enabled:true}}})
  const routes = new Set<string>()
  engine.observeStageCloses(trade=>{
    if (!trade.executed || routes.has(trade.laneId)) return
    const proofs = [...trade.admission!,trade.executionProof!]
    assert.deepEqual(proofs.map(proof=>proof.stage),["base","main","real","exec"])
    assert.ok(proofs.every(proof=>proof.qualified&&proof.checkedAt===trade.openedAt&&proof.count===proof.required&&proof.profitFactor!>=proof.minPF))
    routes.add(trade.laneId)
  })
  engine.processCandles(symbol,bars.slice(0,125),{eventLimit:0})
  const {lanes} = engine.exportState()
  const coordinates = new Set<string>()
  for (const id of routes) {
    const lane = lanes[id]
    const {ancestors,windows:blocks} = lane.config.branch!
    coordinates.add([...ancestors.map(parent=>parent.coordination),lane.coordination,blocks!.exec!.short].join("/"))
  }
  assert.equal(coordinates.size,BRANCH_COORDINATIONS.length**4 * windows.exec.short.length)
  assert.equal(coordinates.size,routes.size,"one independent Set for every window and coordination path")
})

test("each stage's own PF can independently stop the next stage entry", () => {
  const stages = ["base","main","real","exec","live"] as const
  const short = {long:["none"],short:[4],last:[1]}
  const windows = checkExecWindows({base:{long:[10],short:[4],last:[1]},main:short,real:short,exec:short})
  const engine = new TradingEngine({...settings,catalog:{...settings.catalog,strategyExecWindows:windows}})
  let index = 110
  engine.processCandles(symbol,bars.slice(0,index))
  if (engine.hasOpenPositions()) engine.processCandles(symbol,[bars[index++]])
  assert.equal(engine.hasOpenPositions(),false)
  const state = engine.exportState()
  const openedStages = (candidate:TradingEngine) => candidate.processCandles(symbol,[bars[index]],{allowExecution:true})
    .filter(event=>event.type==="opened").map(event=>event.stage)
  assert.deepEqual(openedStages(engine),stages)
  for (const [depth,stage] of stages.slice(0,-1).entries()) {
    const partial = structuredClone(state)
    for (const lane of Object.values(partial.lanes).filter(lane=>lane.stage===stage)) {
      // Last is positive and the Short block has positive net return but only PF 1.05.
      lane.samples = lane.samples.map((_,i)=>[.1,1.03,-1,.01,.01][i]??.2)
    }
    assert.deepEqual(openedStages(TradingEngine.fromOwnedCheckpoint(partial)),stages.slice(0,depth+1),stage)
  }
})
