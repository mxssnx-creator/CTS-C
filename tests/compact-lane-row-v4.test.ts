import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateRawSync } from "node:zlib"
import { TradingEngine } from "../core/engine"
import { StateStore } from "../core/store"
import type { Candle, EngineState, LaneState, StrategyConfig } from "../core/types"

const symbol="BTC-USDT"
const bars:Candle[]=Array.from({length:260},(_,i)=>{
  const close=100+7*Math.sin(i/4)+2*Math.sin(i/11)
  return {timestamp:1_790_000_000_000+i*60_000,open:close,high:close,low:close,close,volume:100}
})
const encodedBytes=(data:string)=>Buffer.byteLength("z1:"+deflateRawSync(Buffer.from(data),{level:1}).toString("base64"))

test("v4 checkpoint compacts durable lane and parent-proof keys without changing exact state",()=>{
  const engine=new TradingEngine({
    symbols:[symbol],connectionId:"terminal-lane-v4",stageGateMode:"parent-branches",
    stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},
    catalog:{strategyEnabledRanges:["Micro"],strategyIndicationTypes:["Trend"],strategyTpSteps:[3],
      strategySlRatios:[1],strategyExitModes:["fixed"],strategySignalTimeframes:[1],
      strategyLastNGrid:{base:[1,2,3],main:[1,2,3],real:[1,2,3]},
      strategyStageCoordinations:{main:["normal"],real:["normal"]}},
  })
  engine.processMarketCandles({[symbol]:bars})
  const expected=JSON.parse(engine.serializeState()) as EngineState
  const metadata=engine.checkpointMetadata(),envelope=JSON.parse(metadata)
  const rows=[...engine.checkpointLanes(true)]
  assert.equal(envelope.laneRowsVersion,4)
  assert.ok(rows.length>20)
  let recursive=0
  for(const row of rows){
    const compact=JSON.parse(row.data)
    for(const key of ["symbol","direction","coordination","stage","samples","closedCount","netPnl","parentProof"])assert.equal(key in compact,false)
    assert.equal(compact.s,expected.lanes[row.id].symbol)
    assert.equal(compact.c,expected.lanes[row.id].configId)
    if(compact.r?.length){
      recursive++
      assert.equal("stage" in compact.r[0],false)
      assert.equal("laneId" in compact.r[0],false)
      assert.equal(typeof compact.r[0].g,"string")
      assert.equal(typeof compact.r[0].i,"string")
    }
  }
  assert.ok(recursive>0)

  const {lanes:ignored,...state}=expected
  const configs:Record<string,StrategyConfig>={}
  let v3RowsBytes=0
  for(const lane of Object.values(expected.lanes)){
    configs[lane.configId]??=lane.config
    const {id,config,configId,...mutable}=lane
    v3RowsBytes+=Buffer.byteLength(id)+encodedBytes(JSON.stringify({...mutable,c:configId}))
  }
  const v3Bytes=Buffer.byteLength(JSON.stringify({checkpointFormat:"lane-rows-v3",payload:{laneRowsVersion:3,state,configs}}))+v3RowsBytes
  const store=new StateStore(":memory:")
  store.migrateLaneCheckpoint(metadata,rows,[],engine.settings,()=>{})
  const stored=store.database.prepare("SELECT data FROM records WHERE key='engine'").get() as {data:string}
  assert.match(stored.data,/^\{"checkpointFormat":"lane-rows-v4"/)
  const storedRows=store.database.prepare("SELECT id,data FROM engine_lanes").all() as {id:string;data:string}[]
  const v4Bytes=Buffer.byteLength(stored.data)+storedRows.reduce((n,row)=>n+Buffer.byteLength(row.id)+Buffer.byteLength(row.data),0)
  assert.ok(v4Bytes<v3Bytes, `v4 ${v4Bytes} did not improve v3 ${v3Bytes}`)
  assert.deepEqual(store.loadEngineState(),expected)
  store.close()
})
