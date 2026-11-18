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

test("v3 lane rows replace repeated config ids with stable bounded references and restore exactly",()=>{
  const engine=new TradingEngine({
    symbols:[symbol],connectionId:"terminal-config-refs",stageGateMode:"parent-branches",
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
  assert.equal(envelope.laneRowsVersion,3)
  assert.ok(rows.length>20)
  for(const row of rows){
    const compact=JSON.parse(row.data)
    assert.equal("configId" in compact,false)
    assert.equal(typeof compact.c,"string")
    assert.equal("configRef" in compact,false)
    const config=envelope.configs[compact.c] as StrategyConfig|undefined
    assert.equal(config?.id,expected.lanes[row.id].configId)
  }

  const {lanes:ignored,...state}=expected
  const v2Configs:Record<string,StrategyConfig>={}
  let v2RowsBytes=0
  for(const lane of Object.values(expected.lanes)){
    v2Configs[lane.configId]??=lane.config
    const {id,config,...compact}=lane
    v2RowsBytes+=Buffer.byteLength(id)+encodedBytes(JSON.stringify(compact))
  }
  const v2MetadataBytes=Buffer.byteLength(JSON.stringify({checkpointFormat:"lane-rows-v2",payload:{state,configs:v2Configs}}))
  const store=new StateStore(":memory:")
  store.migrateLaneCheckpoint(metadata,rows,[],engine.settings,()=>{})
  const stored=store.database.prepare("SELECT data FROM records WHERE key='engine'").get() as {data:string}
  assert.match(stored.data,/^\{"checkpointFormat":"lane-rows-v3"/)
  const storedRows=store.database.prepare("SELECT id,data FROM engine_lanes").all() as {id:string;data:string}[]
  const v3Bytes=Buffer.byteLength(stored.data)+storedRows.reduce((n,row)=>n+Buffer.byteLength(row.id)+Buffer.byteLength(row.data),0)
  assert.ok(v3Bytes<v2MetadataBytes+v2RowsBytes, `v3 ${v3Bytes} did not improve v2 ${v2MetadataBytes+v2RowsBytes}`)
  assert.deepEqual(store.loadEngineState(),expected)
  store.close()
})
