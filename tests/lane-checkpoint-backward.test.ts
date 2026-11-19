import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import { StateStore } from "../core/store"
import type { Candle, EngineState, StrategyConfig } from "../core/types"

const symbol="BTC-USDT"
const bars:Candle[]=Array.from({length:180},(_,i)=>{
  const close=100+7*Math.sin(i/4)+2*Math.sin(i/11)
  return {timestamp:1_790_000_000_000+i*60_000,open:close,high:close,low:close,close,volume:100}
})

test("v4 writer retains exact v2 and v3 checkpoint reads",()=>{
  const engine=new TradingEngine({
    symbols:[symbol],connectionId:"terminal-checkpoint-compat",stageGateMode:"parent-branches",
    stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},
    catalog:{strategyEnabledRanges:["Micro"],strategyIndicationTypes:["Trend"],strategyTpSteps:[3],
      strategySlRatios:[1],strategyExitModes:["fixed"],strategySignalTimeframes:[1],
      strategyLastNGrid:{base:[1,2],main:[1,2],real:[1,2]},
      strategyStageCoordinations:{main:["normal"],real:["normal"]}},
  })
  engine.processMarketCandles({[symbol]:bars})
  const expected=JSON.parse(engine.serializeState()) as EngineState
  const {lanes,...state}=expected
  const configs:Record<string,StrategyConfig>={}
  for(const lane of Object.values(lanes))configs[lane.configId]??=lane.config

  for(const version of [2,3] as const){
    const metadata=JSON.stringify(version===3?{laneRowsVersion:3,state,configs}:{state,configs})
    const rows=Object.values(lanes).map(lane=>{
      const {id,config,...v2}=lane
      if(version===2)return {id,data:JSON.stringify(v2)}
      const {configId,...mutable}=v2
      return {id,data:JSON.stringify({...mutable,c:configId})}
    })
    const store=new StateStore(":memory:")
    store.migrateLaneCheckpoint(metadata,rows,[],engine.settings,()=>{})
    const record=store.database.prepare("SELECT data FROM records WHERE key='engine'").get() as {data:string}
    assert.match(record.data,new RegExp(`^\\{"checkpointFormat":"lane-rows-v${version}"`))
    assert.deepEqual(store.loadEngineState(),expected)
    store.close()
  }
})
