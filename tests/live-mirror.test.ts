import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'
import type {Candle,EngineState} from '../core/types'

const bars:Candle[]=Array.from({length:700},(_,i)=>{const close=100+10*Math.sin(i/5)+2*Math.sin(i/13);return {timestamp:1790000040000+i*60000,open:close,high:close,low:close,close,volume:100}})
const settings={symbols:['BTC-USDT'],liveEntryMode:'real-mirror' as const,stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:['Trend']},coordinations:{axis:{enabled:true,previous:1,last:1,outcome:'any' as const},block:{enabled:true,steps:2,ratio:.2,mode:'shared' as const},dca:{enabled:true,steps:2,distancePct:.1,multiplier:.2}}}
const normalized=(s:EngineState)=>{const {startedAt,...rest}=s;return JSON.parse(JSON.stringify(rest))}

test('continuous mirroring links every Live entry to the same fresh Real fills and retains every paired loss',()=>{
 const e=new TradingEngine(settings),real=new Map<string,any>(),closed=new Map<string,any>();let count=0,losses=0
 for(const bar of bars.slice(0,300)){const events=e.processCandles('BTC-USDT',[bar],{allowExecution:true}),state=e.exportState()
  for(const event of events){const lane=state.lanes[event.laneId]
   if(event.type==='opened'&&event.stage==='real')real.set(lane.open!.id,lane.open)
   if(event.type==='opened'&&event.stage==='live'){const p=lane.open!,parent=real.get(p.parentPositionId!);assert.ok(parent);assert.equal(p.openedAt,bar.timestamp);assert.equal(parent.openedAt,p.openedAt);assert.deepEqual(parent.fills,p.fills);assert.equal(e.isLiveIntentEligible(p.id),true)}
   if(event.trade?.stage==='real')closed.set(event.trade.id,event.trade)
   if(event.trade?.stage==='live'){const a=event.trade,b=closed.get(a.parentPositionId!);assert.ok(b);for(const key of ['openedAt','closedAt','entryPrice','exitPrice','quantity','notional','cost','netPnl','netReturnPct','reason','fills'])assert.deepEqual(a[key as keyof typeof a],b[key]);count++;if(a.netPnl<0)losses++}
  }
 }
 assert.ok(count>50);assert.ok(losses>0);assert.ok(e.pendingIntents().filter(i=>i.kind==='entry').every(i=>i.realPositionId))
 for(const c of ['normal','axis','block','dca'])assert.ok(e.snapshot().liveTrades.some(t=>t.coordination===c),c)
})

test('a pending mirrored entry fails when current Real evidence, its exact parent or an ancestor is missing',()=>{
 const e=new TradingEngine(settings);let state:EngineState|undefined,id=''
 for(const bar of bars){e.processCandles('BTC-USDT',[bar],{allowExecution:true});const live=e.snapshot().positions.find(p=>p.stage==='live'&&p.coordination==='normal');if(live){state=e.exportState();id=live.id;break}}
 assert.ok(state)
 for(const fault of ['real-evidence','real-parent','base-evidence']){
  const copy:EngineState=structuredClone(state)
  const live=Object.values(copy.lanes).find(l=>l.open?.id===id)!,real=Object.values(copy.lanes).find(l=>l.open?.id===live.open!.parentPositionId)!
  if(fault==='real-evidence')real.samples=[]
  if(fault==='real-parent')real.open!.id+='sibling'
  if(fault==='base-evidence')Object.values(copy.lanes).find(l=>l.stage==='base'&&l.configId===live.configId&&l.direction===live.direction&&l.coordination===live.coordination)!.samples=[]
  assert.equal(new TradingEngine(copy.settings,copy).isLiveIntentEligible(id),false,fault)
 }
})

test('mirroring restarts exactly and switching its mode preserves Base/Main/Real identities and losses',()=>{
 const e=new TradingEngine(settings);e.processCandles('BTC-USDT',bars.slice(0,317),{allowExecution:true})
 const restored=TradingEngine.fromSerialized(e.serializeState());e.processCandles('BTC-USDT',bars.slice(317),{allowExecution:true});restored.processCandles('BTC-USDT',bars.slice(317),{allowExecution:true});assert.deepEqual(normalized(restored.exportState()),normalized(e.exportState()))
 const previous=e.exportState();e.updateSettings({liveEntryMode:'independent'})
 const current=e.snapshot().lanes;for(const lane of Object.values(previous.lanes).filter(l=>l.stage!=='live'))assert.ok(current.some(l=>l.id===lane.id))
 for(const stage of ['base','main','real','live'])assert.equal(e.snapshot().stages.find(s=>s.stage===stage)!.closed,Object.values(previous.lanes).filter(l=>l.stage===stage).reduce((sum,l)=>sum+l.closedCount,0))
})
