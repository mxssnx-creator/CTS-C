import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import type { Candle } from "../core/types"

const symbol="BTC-USDT"
const bars:Candle[]=Array.from({length:260},(_,i)=>{
  const close=100+7*Math.sin(i/4)+2*Math.sin(i/11)
  return {timestamp:1_790_000_000_000+i*60_000,open:close,high:close,low:close,close,volume:100}
})
const create=()=>new TradingEngine({
  symbols:[symbol],connectionId:"terminal-weak-membership",stageGateMode:"parent-branches",
  stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},
  catalog:{strategyEnabledRanges:["Micro"],strategyIndicationTypes:["Trend"],strategyTpSteps:[3],
    strategySlRatios:[1],strategyExitModes:["fixed"],strategySignalTimeframes:[1],
    strategyLastNGrid:{base:[1,2,3],main:[1,2,3],real:[1,2,3]},
    strategyStageCoordinations:{main:["normal"],real:["normal"]}},
})

const membership=(engine:TradingEngine)=>engine as unknown as {
  currentLaneIds?:unknown
  validLineages:Set<string>
}

test("current lane membership is derived from the compact context index without a retained id Set",()=>{
  const engine=create()
  engine.processMarketCandles({[symbol]:bars})
  assert.equal(membership(engine).currentLaneIds,undefined)
  assert.ok(membership(engine).validLineages instanceof Set)
  const serialized=engine.serializeState()
  const restored=TradingEngine.fromSerialized(serialized)
  assert.equal(membership(restored).currentLaneIds,undefined)
  assert.deepEqual(JSON.parse(restored.serializeState()),JSON.parse(serialized))
})
