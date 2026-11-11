import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine } from "../core/engine"
import { generateStrategyCatalog } from "../core/catalog"
import { INDICATIONS } from "../core/indications"
import { replayStrategy } from "../core/replay"

const start=1700000040000
const bars=Array.from({length:1200},(_,i)=>{const close=100+8*Math.sin(i/9)+2*Math.sin(i/23);return {timestamp:start+i*60000,open:close,high:close,low:close,close,volume:1}})
const coordinations={axis:{enabled:false,previous:8,last:3,outcome:"any" as const},block:{enabled:false,steps:3,ratio:.2,mode:"shared" as const},dca:{enabled:false,steps:2,distancePct:1,multiplier:2}}

test("research and engine produce identical independent long/short exits for all indications and modes",()=>{
  for(const type of INDICATIONS)for(const mode of ["fixed","trailing","trailing-only"]){
    const catalog={strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:[mode],strategyIndicationTypes:[type]}
    const configs=generateStrategyCatalog("parity",catalog)
    const engine=new TradingEngine({connectionId:"parity",symbols:["BTC-USDT"],catalog,coordinations,stageLastN:{base:1000,main:1000,real:1000},maxSamples:1000})
    const events=engine.processCandles("BTC-USDT",bars)
    for(const config of configs){
    const actual=events.filter(e=>e.stage==='base'&&e.trade?.configId===config.id).map(e=>e.trade!).map(t=>({entry:t.openedAt,exit:t.closedAt,direction:t.direction,result:t.netReturnPct,reason:t.reason})).sort((a,b)=>a.exit-b.exit||a.direction.localeCompare(b.direction))
    const expected=replayStrategy("BTC-USDT",bars,config,5000).filter(p=>p.status==="closed").map(p=>({entry:Date.parse(p.entry_time),exit:Date.parse(p.exit_time!),direction:p.direction,result:p.result!,reason:(p as any).exit_reason})).sort((a,b)=>a.exit-b.exit||a.direction!.localeCompare(b.direction!))
    assert.equal(actual.length,expected.length,`${type}/${mode} close count`)
    for(let i=0;i<actual.length;i++){assert.deepEqual({...actual[i],result:0},{...expected[i],result:0});assert.ok(Math.abs(actual[i].result-expected[i].result)<1e-10)}
    }
  }
})

test("Live risk is refused when an ancestor dequalifies or its configuration is retired",()=>{
  const catalog={strategyTpSteps:[3],strategySlRatios:[.2],strategyExitModes:["fixed"],strategyIndicationTypes:["MA_Cross"]}
  const engine=new TradingEngine({symbols:["BTC-USDT"],catalog,coordinations,stageLastN:{base:1,main:1,real:1}})
  let id:string|undefined
  for(const candle of bars){
    const events=engine.processCandles("BTC-USDT",[candle],{allowExecution:true})
    const event=events.find(e=>e.type==="opened"&&e.stage==="live")
    if(event){id=engine.exportState().lanes[event.laneId].open!.id;break}
  }
  assert.ok(id);assert.equal(engine.isLiveIntentEligible(id),true)
  const state=engine.exportState(), live=Object.values(state.lanes).find(l=>l.open?.id===id)!
  const ancestor=Object.values(state.lanes).find(l=>l.configId===live.configId&&l.direction===live.direction&&l.stage==="base")!
  ancestor.samples=[-1]
  const changed=new TradingEngine(state.settings,state)
  assert.equal(changed.activePositionIds().has(id),true)
  assert.equal(changed.isLiveIntentEligible(id),false)
  engine.updateSettings({catalog:{...catalog,strategyIndicationTypes:["RSI_Band"]}})
  assert.equal(engine.isLiveIntentEligible(id),false)
  assert.equal(engine.snapshot().stages.find(s=>s.stage==="live")!.currentLanes,0)
})

test("retired lane losses remain in lifetime PF while current counts and windows are independent",()=>{
  const engine=new TradingEngine({symbols:["BTC-USDT"],coordinations,catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:["fixed"],strategyIndicationTypes:["MA_Cross"]}})
  engine.processCandles("BTC-USDT",bars.slice(0,500))
  const before=engine.snapshot().stages[0]
  engine.updateSettings({catalog:{strategyTpSteps:[8],strategySlRatios:[1],strategyExitModes:["fixed"],strategyIndicationTypes:["RSI_Band"]}})
  const retired=engine.snapshot().stages[0]
  assert.equal(retired.currentLanes,0);assert.equal(retired.closed,before.closed);assert.equal(retired.profitFactor,before.profitFactor)
  engine.processCandles("BTC-USDT",bars.slice(500))
  const after=engine.snapshot().stages[0]
  assert.ok(after.currentLanes>0);assert.ok(after.lanes>after.currentLanes);assert.ok(after.closed>=before.closed)
})

test("removed symbols retain exits and tracking while retired positions cannot add risk",()=>{
  const engine=new TradingEngine({symbols:["BTC-USDT"],catalog:{strategyTpSteps:[30],strategySlRatios:[2.2],strategyExitModes:["fixed"],strategyIndicationTypes:["MA_Cross"]},coordinations:{...coordinations,dca:{enabled:true,steps:2,distancePct:.2,multiplier:2}}})
  for(const candle of bars){engine.processCandles("BTC-USDT",[candle]);if(engine.snapshot().positions.some(p=>p.coordination==="dca"))break}
  const open=engine.snapshot().positions.find(p=>p.coordination==="dca")!
  assert.ok(open)
  engine.updateSettings({symbols:["ETH-USDT"]})
  assert.ok(engine.managedSymbols().includes("BTC-USDT"))
  const sign=open.direction==="long"?1:-1
  engine.processTick("BTC-USDT",open.entryPrice*(1-sign*.003),open.openedAt+1000)
  assert.equal(engine.snapshot().positions.find(p=>p.id===open.id)!.fills.length,1)
  const close={timestamp:open.openedAt+60000,open:open.entryPrice*(1-sign*.5),high:open.entryPrice*(1-sign*.5),low:open.entryPrice*(1-sign*.5),close:open.entryPrice*(1-sign*.5),volume:1}
  const events=engine.processCandles("BTC-USDT",[close])
  assert.ok(events.some(e=>e.type==="closed"&&e.trade?.id===open.id))
  assert.equal(events.some(e=>e.type==="opened"),false)
})
