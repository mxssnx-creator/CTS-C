import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'
import {TerminalRuntime} from '../core/runtime'
import {StateStore} from '../core/store'
import type {EngineEvent} from '../core/types'

test('bounded audit events preserve every calculation, position, intent and admitted PF outcome',()=>{
 const settings={symbols:['BTC-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']},stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0}}
 const all=new TradingEngine(settings),bounded=new TradingEngine(settings),none=new TradingEngine(settings)
 const bars=Array.from({length:1000},(_,i)=>{const close=100+8*Math.sin(i/17);return {timestamp:1700000040000+i*60000,open:close,high:close,low:close,close,volume:1}})
 const events=all.processCandles('BTC-USDT',bars,{allowExecution:true}),retained=bounded.processCandles('BTC-USDT',bars,{allowExecution:true,eventLimit:7})
 assert.ok(events.length>100);assert.deepEqual(retained,events.slice(-7));assert.deepEqual(none.processCandles('BTC-USDT',bars,{allowExecution:true,eventLimit:0}),[])
 const normalize=(engine:TradingEngine)=>{const state=engine.exportState();state.startedAt=0;return state}
 assert.deepEqual(normalize(bounded),normalize(all));assert.deepEqual(normalize(none),normalize(all))
})

test('a 200000-event burst cannot overflow runtime checkpoint arguments and retains its newest audit records',()=>{
 const store=new StateStore(':memory:'),runtime=new TerminalRuntime('bingx-x02',store)
 try{
  const events:EngineEvent[]=Array.from({length:200000},(_,i)=>({type:'execution',laneId:'audit-'+i,timestamp:i+1,stage:'base'}))
  assert.doesNotThrow(()=>(runtime as any).persist(events))
  const retained=store.events(1000)
  assert.equal(retained[0].laneId,'audit-199999');assert.equal(retained.at(-1)!.laneId,'audit-199000')
  assert.equal(runtime.engine.snapshot({laneLimit:0,positionLimit:0}).processedCandles,0)
 }finally{runtime.shutdown();store.close()}
})
