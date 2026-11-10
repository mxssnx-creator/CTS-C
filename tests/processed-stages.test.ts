import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine,validateEngineSettings} from '../core/engine'
import {DEFAULTS,flatEngineSettings,validateConfiguration} from '../core/settings-schema'
import type {Candle,EngineSettings,EngineState} from '../core/types'
const bars:Candle[]=Array.from({length:700},(_,i)=>{const close=100+10*Math.sin(i/5)+2*Math.sin(i/13);return {timestamp:1790000000000+i*60000,open:close,high:close,low:close,close,volume:100}})
function settings():EngineSettings{return validateEngineSettings({symbols:['BTC-USDT'],stageGateMode:'processed-sets',stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']},coordinations:{axis:{enabled:true,previous:1,last:1,outcome:'any'},block:{enabled:true,steps:2,ratio:.2,mode:'shared'},dca:{enabled:true,steps:2,distancePct:.1,multiplier:.2}}})}
const clean=(state:EngineState)=>{const {startedAt,...rest}=state;return JSON.parse(JSON.stringify(rest))}
test('processed stages start with empty own evidence and preserve exact Real/Live entries, exits, fees and fills',()=>{
 const cfg=settings();cfg.catalog.strategyExitModes=['fixed','trailing','trailing-only']
 const e=new TradingEngine(cfg),real=new Map<string,any>(),closedReal=new Map<string,any>();let liveOpened=0,liveClosed=0
 const seen=new Set<string>()
 for(const candle of bars.slice(0,300)){
  const events=e.processCandles('BTC-USDT',[candle],{allowExecution:true}),state=e.exportState()
  for(const event of events){const lane=state.lanes[event.laneId]
   if(event.type==='opened'){
    if(!seen.has(lane.id)){seen.add(lane.id);assert.equal(lane.samples.length,0);if(lane.stage!=='base')assert.equal(lane.parentProof!.length,['base','main','real','live'].indexOf(lane.stage))}
    if(lane.stage==='real')real.set(lane.open!.id,lane.open)
    if(lane.stage==='live'){liveOpened++;const p=lane.open!,parent=real.get(p.parentPositionId!);assert.ok(parent);assert.equal(p.openedAt,parent.openedAt);assert.equal(p.entryPrice,parent.entryPrice);assert.deepEqual(p.fills,parent.fills);assert.equal(e.isLiveIntentEligible(p.id),true)}
   }
   if(event.trade?.stage==='real')closedReal.set(event.trade.id,event.trade)
   if(event.trade?.stage==='live'){liveClosed++;const t=event.trade,parent=closedReal.get(t.parentPositionId!);assert.ok(parent);for(const key of ['openedAt','closedAt','entryPrice','exitPrice','quantity','notional','grossPnl','cost','netPnl','netReturnPct','reason','fills'])assert.deepEqual(t[key as keyof typeof t],parent[key],key)}
  }
 }
 assert.ok(liveOpened>50&&liveClosed>50);assert.equal(new Set(e.pendingIntents().map(i=>i.id)).size,e.pendingIntents().length)
 assert.ok(e.pendingIntents().filter(i=>i.kind==='entry').every(i=>i.realPositionId))
 assert.deepEqual(new Set(e.snapshot().lanes.filter(l=>l.stage==='live').map(l=>l.coordination)),new Set(['normal','axis','block','dca']))
})
test('processed Main and Real continue from own sets after older windows change, while current Real still gates submission',()=>{
 const e=new TradingEngine(settings());let state:EngineState|undefined,positionId=''
 for(const bar of bars){e.processCandles('BTC-USDT',[bar],{allowExecution:true});const p=e.snapshot().positions.find(p=>p.stage==='live'&&p.coordination==='normal');if(p){state=e.exportState();positionId=p.id;break}}
 assert.ok(state);const p=Object.values(state.lanes).find(l=>l.open?.id===positionId)!
 for(const lane of Object.values(state.lanes))if(lane.stage==='base'||lane.stage==='main')lane.samples=[]
 const check=new TradingEngine(state.settings,state);assert.equal(check.isLiveIntentEligible(positionId),true,'old windows cannot veto the independently admitted Real set')
 const before=check.snapshot().stages.find(s=>s.stage==='main')!.closed
 check.processCandles('BTC-USDT',bars.filter(b=>b.timestamp>state!.updatedAt).slice(0,100));assert.ok(check.snapshot().stages.find(s=>s.stage==='main')!.closed>before)
 const real=Object.values(state.lanes).find(l=>l.open?.id===p.open!.parentPositionId)!
 real.samples=[];assert.equal(new TradingEngine(state.settings,state).isLiveIntentEligible(positionId),false,'empty Real evidence blocks a pending entry')
 real.samples=[1];delete real.open;assert.equal(new TradingEngine(state.settings,state).isLiveIntentEligible(positionId),false,'closed Real parent blocks a delayed entry')
})
test('processed lineage rejects sibling proof and restart preserves all subsequent outcomes and pending links',()=>{
 const e=new TradingEngine(settings());e.processCandles('BTC-USDT',bars.slice(0,337),{allowExecution:true})
 const restored=TradingEngine.fromSerialized(e.serializeState());e.processCandles('BTC-USDT',bars.slice(337),{allowExecution:true});restored.processCandles('BTC-USDT',bars.slice(337),{allowExecution:true});assert.deepEqual(clean(restored.exportState()),clean(e.exportState()))
 const state=e.exportState(),live=Object.values(state.lanes).find(l=>l.stage==='live'&&l.open)
 assert.ok(live);const real=Object.values(state.lanes).find(l=>l.open?.id===live.open!.parentPositionId)!
 real.parentProof![0].laneId+='foreign';assert.equal(new TradingEngine(state.settings,state).isLiveIntentEligible(live.open!.id),false)
})
test('mode changes share only Base facts, isolate derived sets, and leave absent legacy checkpoints continuous',()=>{
 const e=new TradingEngine(settings());e.processCandles('BTC-USDT',bars.slice(0,300));const first=e.snapshot(),base=first.lanes.filter(l=>l.stage==='base').map(l=>l.id),derived=new Set(first.lanes.filter(l=>l.stage!=='base').map(l=>l.id))
 e.updateSettings({stageGateMode:'continuous-ancestors'});e.processCandles('BTC-USDT',bars.slice(300,500));const after=e.exportState()
 assert.deepEqual(Object.values(after.lanes).filter(l=>l.stage==='base').map(l=>l.id),base)
 assert.ok(e.snapshot().stages.find(s=>s.stage==='main')!.currentLanes>0)
 assert.ok(Object.values(after.lanes).filter(l=>l.stage==='main'&&!derived.has(l.id)).every(l=>l.parentProof===undefined))
 const old=e.exportState();delete old.settings.stageGateMode;assert.equal(TradingEngine.fromSerialized(JSON.stringify(old)).settings.stageGateMode,'continuous-ancestors')
 assert.throws(()=>e.updateSettings({stageGateMode:'invalid' as any}))
 assert.equal(validateConfiguration(DEFAULTS).stageGateMode,'continuous-ancestors');assert.equal(flatEngineSettings(e.settings,{symbolCount:1,historyCandles:100}).stageGateMode,'continuous-ancestors')
})
