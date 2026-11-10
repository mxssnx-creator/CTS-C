import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateStrategyCatalog} from '../core/catalog'
import {advanceSignal,advanceConfiguredSignal,newSignalState,replayStrategy,strategySignalTrace} from '../core/replay'
import {TradingEngine} from '../core/engine'
import {CORE_INDICATIONS,TECHNICAL_INDICATIONS} from '../core/indications'
const start=Date.parse('2026-01-01T00:00:00Z')
const bar=(price:number,i:number,volume=1)=>({timestamp:start+(i+1)*60000,open:price,high:price+.01,low:price-.01,close:price,volume})

test('new period and timeframe grids have independent identities and preserve the existing catalog',()=>{
 const base={strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed']}
 const now='2026-01-01T00:00:00Z'
 const old=generateStrategyCatalog('test',{...base,strategyIndicationTypes:[...CORE_INDICATIONS]},now)
 const expanded=generateStrategyCatalog('test',{...base,strategyIndicationTypes:[...CORE_INDICATIONS,'Trend','Break'],strategySignalPeriods:[10,20],strategySignalTimeframes:[1,5]},now)
 assert.equal(expanded.length,12);assert.equal(new Set(expanded.map(c=>c.id)).size,12)
 assert.deepEqual(expanded.filter(c=>(CORE_INDICATIONS as readonly string[]).includes(c.type)),old)
})

test('five-minute stream equals explicitly aggregated complete candles and ignores partial/gapped frames',()=>{
 const config={type:'Trend',position_cost_step:10,signalTimeframeMinutes:5},state=newSignalState(),control=newSignalState()
 for(let i=0;i<400;i++){
  const candle=bar(100+i*.02+Math.sin(i/7),i)
  const actual=advanceConfiguredSignal(state,candle,config)
  if(i%5!==4){assert.equal(actual,undefined);continue}
  const group=Array.from({length:5},(_,j)=>bar(100+(i-4+j)*.02+Math.sin((i-4+j)/7),i-4+j))
  const completed={...candle,open:group[0].open,high:Math.max(...group.map(b=>b.high)),low:Math.min(...group.map(b=>b.low)),volume:5}
  const expected=advanceSignal(control,candle.close,'Trend',10,completed)
  assert.equal(actual,expected)
 }
 assert.deepEqual(state.technical,control.technical)
 const incomplete=newSignalState()
 for(let i=2;i<5;i++)advanceConfiguredSignal(incomplete,bar(100+i,i),config)
 assert.equal(incomplete.count,0)
 for(const i of [5,6,8,9])advanceConfiguredSignal(incomplete,bar(100+i,i),config)
 assert.equal(incomplete.count,0)
 const restored=JSON.parse(JSON.stringify(state))
 for(let i=400;i<450;i++)assert.equal(advanceConfiguredSignal(state,bar(100+i*.02,i),config),advanceConfiguredSignal(restored,bar(100+i*.02,i),config))
 assert.deepEqual(restored,state)
})

test('breakout references exclude the current high and volume confirmation requires observed volume',()=>{
 for(const type of ['Break','Break_Volume']){
  const s=newSignalState()
  for(let i=0;i<30;i++)advanceSignal(s,100+i*.01,type,10,bar(100+i*.01,i,1))
  const close=103,event=advanceSignal(s,close,type,10,{...bar(close,30,3),high:104})
  assert.equal(event,'long',type)
 }
 const noVolume=newSignalState()
 for(let i=0;i<30;i++)advanceSignal(noVolume,100+i*.01,'Break_Volume',10,bar(100+i*.01,i,0))
 assert.equal(advanceSignal(noVolume,103,'Break_Volume',10,bar(103,30,0)),undefined)
})

test('every new indication is causal, serializable and bounded',()=>{
 const candles=Array.from({length:1000},(_,i)=>bar(100+i*.005+5*Math.sin(i/15),i,i%11===0?4:1))
 for(const type of TECHNICAL_INDICATIONS){
  const state=newSignalState(),prefix=candles.slice(0,600).map(c=>advanceSignal(state,c.close,type,20,c))
  const checkpoint=JSON.parse(JSON.stringify(state))
  const rest=candles.slice(600).map(c=>advanceSignal(state,c.close,type,20,c))
  assert.deepEqual(candles.slice(600).map(c=>advanceSignal(checkpoint,c.close,type,20,c)),rest)
  const fresh=newSignalState();assert.deepEqual(candles.slice(0,600).map(c=>advanceSignal(fresh,c.close,type,20,c)),prefix)
  assert.ok(state.technical!.bars.length<=Math.max(20,60))
 }
})

test('adapted Trend Fade and reversal Break produce actual reversal signals',()=>{
 const fade=newSignalState(),trend=Array.from({length:50},(_,i)=>100+i)
 let observed=false
 for(const [i,price] of [...trend,148,147,146,145].entries())if(advanceSignal(fade,price,'Trend_Fade',20,bar(price,i))==='short')observed=true
 assert.equal(observed,true,'a stretched rising trend must recognize a completed three-bar downward turn')
 const reversal=newSignalState(),prices=[...Array.from({length:65},(_,i)=>100-i*.5),68.1,68.2,68.5,69,69.5,74]
 let fired=false
 for(const [i,price] of prices.entries())if(advanceSignal(reversal,price,'Break_Reversal',10,bar(price,i))==='long')fired=true
 assert.equal(fired,true,'a fresh upside channel break against a large prior decline must qualify')
})

test('Trend and Break coordinations progress independently through all stages',()=>{
 for(const stageGateMode of ['continuous-ancestors','processed-sets'] as const)for(const type of ['Trend','Break']){
  const engine=new TradingEngine({stageGateMode,symbols:['BTC-USDT'],stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:[type]},coordinations:{axis:{enabled:true,previous:1,last:1,outcome:'any'},block:{enabled:true,steps:2,ratio:.2,mode:'shared'},dca:{enabled:true,steps:2,distancePct:.1,multiplier:.2}}})
  engine.processCandles('BTC-USDT',Array.from({length:2000},(_,i)=>bar(100+9*Math.sin(i/18),i)))
  const lanes=Object.values(engine.exportState().lanes)
  for(const coordination of ['normal','axis','block','dca'])for(const stage of ['base','main','real','live'])assert.ok(lanes.some(l=>l.coordination===coordination&&l.stage===stage&&l.closedCount>0),`${type}/${coordination}/${stage}`)
 }
})

test('Trend/Break replay and engine exits match over periods, timeframes and all exit modes',()=>{
 const candles=Array.from({length:1600},(_,i)=>bar(100+9*Math.sin(i/21)+2*Math.sin(i/67),i,i%9===0?4:1))
 const disabled={axis:{enabled:false,previous:3,last:1,outcome:'any' as const},block:{enabled:false,steps:2,ratio:.2,mode:'shared' as const},dca:{enabled:false,steps:2,distancePct:1,multiplier:2}}
 for(const type of TECHNICAL_INDICATIONS)for(const period of [10,20])for(const timeframe of [1,5,15])for(const mode of ['fixed','trailing','trailing-only']){
  const catalog={strategyTpSteps:[3],strategySlRatios:[.6],strategyExitModes:[mode],strategyIndicationTypes:[type],strategySignalPeriods:[period],strategySignalTimeframes:[timeframe]}
  const config=generateStrategyCatalog('parity',catalog)[0],engine=new TradingEngine({connectionId:'parity',symbols:['BTC-USDT'],catalog,coordinations:disabled,stageLastN:{base:1000,main:1000,real:1000},maxSamples:1000})
  const actual=engine.processCandles('BTC-USDT',candles).filter(e=>e.trade&&e.stage==='base').map(e=>e.trade!)
  const expected=replayStrategy('BTC-USDT',candles,config,5000).filter(p=>p.status==='closed')
  assert.deepEqual(replayStrategy('BTC-USDT',candles,config,5000,[],strategySignalTrace(candles,config)).filter(p=>p.status==='closed'),expected)
  assert.equal(actual.length,expected.length,`${type}/${period}/${timeframe}/${mode}`)
  for(let i=0;i<actual.length;i++){
   const a=actual[i],b=expected[i]
   assert.equal(a.openedAt,Date.parse(b.entry_time));assert.equal(a.closedAt,Date.parse(b.exit_time!));assert.equal(a.direction,b.direction)
   assert.ok(a.closedAt>a.openedAt);assert.ok(Math.abs(a.netReturnPct-b.result!)<1e-9)
  }
 }
})

test('all Trend/Break ranges remain complete and grid configuration does not truncate candidates',()=>{
 const configs=generateStrategyCatalog('grid',{strategyIndicationTypes:[...TECHNICAL_INDICATIONS],strategySignalPeriods:[10,20],strategySignalTimeframes:[1,5]})
 assert.equal(configs.length,9*28*11*3*2*2);assert.equal(new Set(configs.map(c=>c.id)).size,configs.length)
 for(const type of TECHNICAL_INDICATIONS)for(const range of ['Micro','Minimal','Short','Normal','Long','Wide'])for(const exit of ['fixed','trailing','trailing-only'])assert.ok(configs.some(c=>c.type===type&&c.range===range&&c.exitMode===exit))
})

test('Axis Base reference can avoid redundant source-stage starvation without bypassing its own Real evidence',()=>{
 for(const reference of ['base','same-stage'] as const){
  const engine=new TradingEngine({symbols:['BTC-USDT'],stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[.2],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']},coordinations:{axis:{enabled:true,previous:1,last:1,outcome:'positive',reference},block:{enabled:false,steps:2,ratio:.2,mode:'shared'},dca:{enabled:false,steps:2,distancePct:1,multiplier:2}}})
  let id:string|undefined
  for(let i=0;i<1600;i++){
   const events=engine.processCandles('BTC-USDT',[bar(100+9*Math.sin(i/18),i)],{allowExecution:true})
   const state=engine.exportState(),event=events.find(e=>e.type==='opened'&&e.stage==='live'&&state.lanes[e.laneId].coordination==='axis')
   if(event){id=state.lanes[event.laneId].open!.id;break}
  }
  assert.ok(id)
  const state=engine.exportState(),live=Object.values(state.lanes).find(l=>l.open?.id===id)!
  for(const lane of Object.values(state.lanes))if(lane.configId===live.configId&&lane.direction===live.direction){
   if(lane.coordination==='axis'&&lane.stage!=='live')lane.samples=[1]
   if(lane.coordination==='normal')lane.samples=lane.stage==='base'?[1,1]:[-1,-1]
  }
  const check=new TradingEngine(state.settings,state)
  assert.equal(check.isLiveIntentEligible(id),reference==='base')
  const real=Object.values(state.lanes).find(l=>l.coordination==='axis'&&l.stage==='real'&&l.configId===live.configId&&l.direction===live.direction)!
  real.samples=[];assert.equal(new TradingEngine(state.settings,state).isLiveIntentEligible(id),false,'Normal reference cannot replace own Real qualification')
 }
})
