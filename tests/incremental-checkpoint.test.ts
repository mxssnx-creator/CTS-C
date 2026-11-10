import assert from 'node:assert/strict'
import {test} from 'node:test'
import {StateStore} from '../core/store'
import {TradingEngine} from '../core/engine'
import type {Candle} from '../core/types'
const bars:Candle[]=Array.from({length:500},(_,i)=>{const close=100+9*Math.sin(i/11);return {timestamp:1790000040000+i*60000,open:close,high:close,low:close,close,volume:1}})
function engine(){return new TradingEngine({symbols:['BTC-USDT','ETH-USDT'],stageGateMode:'processed-sets',stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3,5],strategySlRatios:[1],strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:['Trend']},coordinations:{axis:{enabled:true,previous:1,last:1,outcome:'any'},block:{enabled:true,steps:2,ratio:.2,mode:'shared'},dca:{enabled:true,steps:2,distancePct:.1,multiplier:.2}}})}
function save(store:StateStore,e:TradingEngine){const settings=e.settings,meta=e.checkpointMetadata();if(store.hasLaneCheckpoint())store.saveLaneCheckpoint(meta,e.checkpointLanes(),[],settings,()=>{});else store.migrateLaneCheckpoint(meta,e.checkpointLanes(true),[],settings,()=>{});e.checkpointSaved()}
test('incremental checkpoints preserve exact full state through entries, adds, closes, ticks, settings and restart',()=>{
 const store=new StateStore(':memory:'),e=engine()
 try{
  for(let i=0;i<300;i+=20){e.processCandles('BTC-USDT',bars.slice(i,i+20),{allowExecution:true});save(store,e);assert.deepEqual(store.loadEngineState(),JSON.parse(e.serializeState()));assert.equal([...e.checkpointLanes()].length,0)}
  e.processTick('BTC-USDT',115,bars[299].timestamp+1000);save(store,e);assert.deepEqual(store.loadEngineState(),JSON.parse(e.serializeState()))
  const old=store.database.prepare('SELECT data FROM engine_lanes').all().map(r=>r.data)
  e.processCandles('ETH-USDT',bars.slice(0,40));save(store,e)
  const btc=store.database.prepare("SELECT data FROM engine_lanes WHERE json_extract(data,'$.symbol')='BTC-USDT'").all().map(r=>r.data)
  assert.deepEqual(btc,old,'another symbol cannot rewrite or alter committed BTC lanes')
  e.updateSettings({stageLastN:{base:1,main:1,real:1},maxSamples:10,stageGateMode:'continuous-ancestors'});save(store,e)
  assert.deepEqual(store.get('engine'),JSON.parse(e.serializeState()));assert.deepEqual(store.engineSettings(),e.settings)
  const restored=TradingEngine.fromOwnedCheckpoint(store.loadEngineState()!)
  e.processCandles('BTC-USDT',bars.slice(300),{allowExecution:true});restored.processCandles('BTC-USDT',bars.slice(300),{allowExecution:true});assert.deepEqual(JSON.parse(restored.serializeState()),JSON.parse(e.serializeState()))
 }finally{store.close()}
})
test('a failed dirty checkpoint rolls back metadata, lanes, settings and audit events and can be retried',()=>{
 const store=new StateStore(':memory:'),e=engine()
 try{
  e.processCandles('BTC-USDT',bars.slice(0,100));save(store,e);const before=store.getRaw('engine')
  e.processCandles('BTC-USDT',bars.slice(100,150));const rows=[...e.checkpointLanes()];assert.ok(rows.length>0)
  function* broken(){yield rows[0];throw Error('Interrupted checkpoint')}
  assert.throws(()=>store.saveLaneCheckpoint(e.checkpointMetadata(),broken(),[{type:'should-roll-back'}],e.settings,()=>{}),/Interrupted checkpoint/)
  assert.equal(store.getRaw('engine'),before);assert.equal(store.events().length,0);assert.equal([...e.checkpointLanes()].length,rows.length)
  save(store,e);assert.deepEqual(store.loadEngineState(),JSON.parse(e.serializeState()))
 }finally{store.close()}
})
test('interrupted legacy migration remains invisible and preserves every original lane and owned journal row',()=>{
 const store=new StateStore(':memory:'),e=engine()
 try{
  const symbols=Array.from({length:10},(_,i)=>`TEST${i}-USDT`);e.updateSettings({symbols});for(const symbol of symbols)e.processCandles(symbol,bars.slice(0,100));assert.ok([...e.checkpointLanes(true)].length>500);const serialized=e.serializeState();store.saveEngineJSON(serialized,[],e.settings);store.claimIntent('own-order',{symbol:'BTC-USDT'})
  let calls=0;assert.throws(()=>store.migrateLaneCheckpoint(e.checkpointMetadata(),e.checkpointLanes(true),[],e.settings,()=>{if(++calls===5)throw Error('Lease unavailable')}),/Lease unavailable/)
  assert.equal(store.hasLaneCheckpoint(),false);assert.ok(Number((store.database.prepare('SELECT COUNT(*) AS n FROM engine_lanes').get() as any).n)>0,'a committed partial migration remains invisible');assert.equal(store.getRaw('engine'),serialized);assert.equal(store.intents().length,1)
  store.migrateLaneCheckpoint(e.checkpointMetadata(),e.checkpointLanes(true),[],e.settings,()=>{});e.checkpointSaved()
  assert.deepEqual(store.loadEngineState(),JSON.parse(serialized));assert.equal(store.intents().length,1)
  const restored=store.loadEngineState()!,lanes=Object.values(restored.lanes),shared=lanes.filter(l=>l.configId===lanes[0].configId)
  assert.ok(shared.length>1);assert.ok(shared.every(l=>l.config===shared[0].config),'identical immutable config objects are pooled after load')
 }finally{store.close()}
})
