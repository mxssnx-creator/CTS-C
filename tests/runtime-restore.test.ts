import {test} from 'node:test'
import assert from 'node:assert/strict'
import {StateStore} from '../core/store'
import {TerminalRuntime} from '../core/runtime'
import {TradingEngine} from '../core/engine'

test('a cold journal load longer than the ownership TTL occurs before ownership and unchanged state is reused',()=>{
 const now=Date.now;let clock=1_000_000;Date.now=()=>clock
 const store=new StateStore(':memory:'),engine=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
 store.saveEngineJSON(engine.serializeState(),[],engine.settings)
 const load=store.loadEngineState.bind(store);let reads=0
 store.loadEngineState=()=>{reads++;const state=load();const active=store.database.prepare('SELECT COUNT(*) AS n FROM runtime_lease WHERE expires>?').get(clock) as {n:number};assert.equal(active.n,0,'a potentially slow hydration must not consume an active lease');clock+=35_000;return state}
 const runtime=new TerminalRuntime('bingx-x02',store)
 try{runtime.pause();assert.equal(reads,1);assert.equal(store.get<any>('control').exchangeExecution,false);clock+=30_001;assert.throws(()=>runtime.pause(),/expired/);assert.throws(()=>runtime.pause(),/ownership was lost/)}finally{runtime.shutdown();store.close();Date.now=now}
})

test('a checkpoint changed after construction reloads outside ownership and is verified before the first mutation',()=>{
 const now=Date.now;let clock=1_000_000;Date.now=()=>clock
 const store=new StateStore(':memory:'),engine=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
 engine.processCandles('BTC-USDT',Array.from({length:120},(_,i)=>{const close=100+8*Math.sin(i/5);return {timestamp:1790000040000+i*60000,open:close,high:close,low:close,close,volume:1}}))
 const metadata=engine.checkpointMetadata();store.migrateLaneCheckpoint(metadata,engine.checkpointLanes(true),[],engine.settings,()=>{})
 const load=store.loadEngineState.bind(store);let reads=0
 store.loadEngineState=()=>{reads++;const state=load();const active=store.database.prepare('SELECT COUNT(*) AS n FROM runtime_lease WHERE expires>?').get(clock) as {n:number};assert.equal(active.n,0);clock+=35_000;return state}
 const runtime=new TerminalRuntime('bingx-x02',store)
 try{
  const before=store.checkpointToken(),row=store.database.prepare('SELECT id,data FROM engine_lanes LIMIT 1').get() as {id:string;data:string},lane=JSON.parse(row.data),oldNet=runtime.snapshot().stages.base.pf
  lane.netPnl+=7;store.saveLaneCheckpoint(metadata,[{id:row.id,data:JSON.stringify(lane)}],[],engine.settings,()=>{});assert.notEqual(store.checkpointToken(),before,'lane-only commits also change the checkpoint generation')
  runtime.pause();assert.equal(reads,2);assert.equal(runtime.snapshot().engine.processedCandles,120);assert.equal(runtime.snapshot().stages.base.pf,oldNet);assert.equal(runtime.snapshot().engine.lanes.find(l=>l.id===row.id)?.netPnl,lane.netPnl)
 }finally{runtime.shutdown();store.close();Date.now=now}
})
