import assert from "node:assert/strict"
import { test } from "node:test"
import { ConfigStageWindows } from "../core/config-stage-windows"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { flatEngineSettings, validateConfiguration } from "../core/settings-schema"
import type { Candle, EngineState, LaneState, Stage } from "../core/types"

const symbols = ["BTC-USDT", "ETH-USDT"]
const stages: Stage[] = ["base", "main", "real", "live"]
const settings = validateEngineSettings({
  symbols, stageGateMode: "processed-sets", stageWindowScope: "config",
  stageLastN: { base: 4, main: 4, real: 4 }, stageMinPF: { base: 0, main: 0, real: 0 },
  catalog: { strategyEnabledRanges: ["Micro"], strategyTpSteps: [3], strategySlRatios: [1, 1.4], strategyExitModes: ["fixed"], strategyIndicationTypes: ["Trend"] },
  coordinations: { axis: {enabled:true,previous:1,last:1,outcome:"any"}, block: {enabled:true,steps:2,ratio:.2,mode:"shared"}, dca: {enabled:true,steps:2,distancePct:.1,multiplier:.2} },
})
const bars = symbols.map((_, k) => Array.from({length: 390}, (_, i): Candle => {
  const close = 100 + 9 * Math.sin(i / 5 + k * 2) + 2 * Math.sin(i / 13)
  return {timestamp: 1790000000000 + i * 60000, open:close, high:close, low:close, close, volume:100}
}))
const series = (start=0,end=390) => Object.fromEntries(symbols.map((symbol,i)=>[symbol,bars[i].slice(start,end)]))

function marketSeed() {
  const engine = new TradingEngine(settings)
  engine.processMarketCandles(series(0,320))
  return engine
}

test("config windows select strictly earlier, newest own closes with stable ties and isolate sibling policies", () => {
  const engine = marketSeed()
  const template = Object.values(engine.exportState().lanes)[0]
  const lane = (id:string,samples:number[],sampleTimes?:number[]):LaneState => ({...template,id,samples,sampleTimes,closedCount:samples.length})
  const a = lane("a",[5,0,-2],[50,40,10]), b = lane("b",[8,4,-1],[60,40,20])
  const legacy = lane("legacy",[99]), adjacent = lane("other",[199],[45])
  const book = new ConfigStageWindows()
  book.add(b,"group");book.add(a,"group");book.add(legacy,"group");book.add(adjacent,"other-stage-or-policy")
  assert.deepEqual(book.evidence(a,40,5)?.samples,[-1,-2])
  assert.deepEqual(book.evidence(b,60,4)?.samples,[5,0,4,-1])
  assert.deepEqual(book.evidence(adjacent,Infinity,4)?.samples,[199])
  a.samples.unshift(-12);a.sampleTimes!.unshift(70);book.settled(a,70)
  assert.deepEqual(book.evidence(b,Infinity,3)?.samples,[-12,8,5])
  const corrupt = lane("corrupt",[1,2],[1,2]);book.add(corrupt,"group")
  assert.deepEqual(book.evidence(a,Infinity,3)?.samples,[NaN])
})

test("pooled stage progression preserves independent Set lineage, causal replay and restart order", () => {
  const engine = new TradingEngine(settings)
  engine.processMarketCandles(series())
  const expected = engine.exportState()
  const partial = new TradingEngine(settings)
  partial.processMarketCandles(series(0,180))
  const restored = TradingEngine.fromSerialized(partial.serializeState())
  restored.processMarketCandles(Object.fromEntries(Object.entries(series(180)).reverse()))
  const withoutStart = ({startedAt: _startedAt,...rest}:EngineState) => rest
  assert.deepEqual(withoutStart(restored.exportState()),withoutStart(expected))
  assert.throws(()=>engine.processMarketCandles({...series(0,1),"ETH-USDT":[bars[1][1],bars[1][0]]}),/unsorted/)
  assert.deepEqual(engine.exportState(),expected)
  const live = Object.values(expected.lanes).filter(lane=>lane.stage==="live")
  assert.deepEqual(new Set(live.map(lane=>lane.coordination)),new Set(["normal","axis","block","dca"]))
  for (const lane of live) {
    assert.equal(lane.parentProof?.length,3)
    for (const [index, proof] of lane.parentProof!.entries()) {
      const parent = expected.lanes[proof.laneId]
      assert.ok(parent)
      assert.deepEqual([parent.symbol,parent.direction,parent.configId,parent.coordination,parent.stage],
        [lane.symbol,lane.direction,lane.configId,lane.coordination,stages[index]])
      assert.equal(proof.windowScope,"config")
    }
  }
  const base = engine.snapshot().stages[0]
  assert.ok(base.validatedWindow!.sets>0)
  assert.ok(base.currentQualified>base.validatedWindow!.sets)
  assert.equal(base.validatedWindow!.samples,4*base.validatedWindow!.sets)
  assert.ok(Object.values(expected.lanes).some(lane=>lane.sampleTimes?.length===5),"retain the prior Last-N when the newest close is simultaneous")
})

test("market replay rejects a second batch with an unseen earlier or same-clock symbol",()=>{
  const engine=new TradingEngine(settings)
  engine.processMarketCandles({"BTC-USDT":bars[0].slice(0,2)})
  const checkpoint=engine.serializeState()
  assert.throws(()=>engine.processMarketCandles({"ETH-USDT":bars[1].slice(1,3)}),/overlaps the decision clock/)
  assert.equal(engine.serializeState(),checkpoint)
})

test("a passing pooled Real window cannot replace exact Real promotion evidence", () => {
  const engine = marketSeed()
  let state = engine.exportState()
  const openLive = () => Object.values(state.lanes).find(lane=>lane.stage==="live"&&lane.coordination==="normal"&&lane.open)
  for(let i=320;!openLive()&&i<350;i++){
    engine.processMarketCandles(series(i,i+1));state=engine.exportState()
  }
  const live = openLive()
  assert.ok(live?.open)
  const real = Object.values(state.lanes).find(lane=>lane.open?.id===live.open!.parentPositionId)
  assert.ok(real)
  const neighbor = Object.values(state.lanes).find(lane=>lane.stage==="real"&&lane.id!==real.id&&lane.configId===real.configId&&lane.coordination===real.coordination&&(lane.sampleTimes?.length??0)>=4)
  assert.ok(neighbor)
  const times = [1,2,3,4].map(n=>state.updatedAt-n*60000)
  real.sampleTimes=times;real.samples=[2,2,2,2]
  live.open.executionEligible=true
  assert.equal(new TradingEngine(settings,state).isLiveIntentEligible(live.open.id),true)
  real.sampleTimes=[];real.samples=[]
  neighbor.sampleTimes=times;neighbor.samples=[2,2,2,2]
  const check = new TradingEngine(settings,state)
  assert.equal(check.snapshot().lanes.find(lane=>lane.id===real.id)?.qualified,true)
  assert.equal(check.isLiveIntentEligible(live.open.id),false)
})

test("Micro override requires both windows and setting edits cannot reuse derived Sets", () => {
  const engine=marketSeed()
  const before=engine.exportState()
  engine.updateSettings({microStageWindowScope:"both"})
  engine.processMarketCandles(series(320))
  const newMain=engine.snapshot().lanes.filter(lane=>lane.stage==="main"&&lane.current)
  assert.ok(newMain.length)
  assert.ok(newMain.every(lane=>!before.lanes[lane.id]&&lane.windowScope==="both"&&lane.configWindow))
  assert.deepEqual(Object.values(engine.exportState().lanes).filter(lane=>lane.stage==="base").map(lane=>lane.id),
    Object.values(before.lanes).filter(lane=>lane.stage==="base").map(lane=>lane.id))
  const flat=validateConfiguration(flatEngineSettings(engine.settings,{symbolCount:2,historyCandles:100}))
  assert.equal(flat.stageWindowScope,"config");assert.equal(flat.microStageWindowScope,"both")
  assert.throws(()=>validateConfiguration({stageWindowScope:"other"},{partial:true}),/stageWindowScope/)
})
