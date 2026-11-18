import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import type { Candle, LaneState } from "../core/types"

const symbol="BTC-USDT"
const bars:Candle[]=Array.from({length:260},(_,i)=>{
  const close=100+7*Math.sin(i/4)+2*Math.sin(i/11)
  return {timestamp:1_790_000_000_000+i*60_000,open:close,high:close,low:close,close,volume:100}
})
const create=()=>new TradingEngine({
  symbols:[symbol],connectionId:"terminal-compact-context",stageGateMode:"parent-branches",
  stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},
  catalog:{strategyEnabledRanges:["Micro"],strategyIndicationTypes:["Trend"],strategyTpSteps:[3],
    strategySlRatios:[1],strategyExitModes:["fixed"],strategySignalTimeframes:[1],
    strategyLastNGrid:{base:[1,2,3],main:[1,2,3],real:[1,2,3]},
    strategyStageCoordinations:{main:["normal"],real:["normal"]}},
})

test("derived context index uses one interleaved direction vector without changing current Set coverage",()=>{
  const engine=create();engine.processMarketCandles({[symbol]:bars})
  const contexts=(engine as unknown as {contexts:Map<string,Map<string,Array<LaneState|undefined>>>}).contexts
  let indexed=0
  for(const configs of contexts.values())for(const context of configs.values()){
    assert.ok(Array.isArray(context))
    assert.equal("long" in context,false)
    assert.equal("short" in context,false)
    indexed+=context.filter(Boolean).length
  }
  const current=engine.snapshot({laneLimit:0,positionLimit:0}).stages.reduce((sum,stage)=>sum+stage.currentLanes,0)
  assert.ok(current>20)
  assert.equal(indexed,current)
  const serialized=engine.serializeState(),restored=TradingEngine.fromSerialized(serialized)
  assert.deepEqual(JSON.parse(restored.serializeState()),JSON.parse(serialized))
  assert.equal(restored.snapshot({laneLimit:0,positionLimit:0}).stages.reduce((sum,stage)=>sum+stage.currentLanes,0),current)
})
