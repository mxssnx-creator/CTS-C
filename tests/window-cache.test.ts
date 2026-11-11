import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'
import type {EngineState} from '../core/types'
const clean=(s:EngineState)=>{const {startedAt,...state}=s;return JSON.parse(JSON.stringify(state))}
test('cached ancestor and Axis windows match fresh reconstruction after every close and settings epoch',()=>{
 const catalog={strategyTpSteps:[3,5],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}
 const settings={symbols:['BTC-USDT'],catalog,stageLastN:{base:3,main:2,real:2},stageMinPF:{base:.5,main:.5,real:.5},coordinations:{axis:{enabled:true,previous:2,last:1,outcome:'any' as const},block:{enabled:true,steps:2,ratio:.2,mode:'shared' as const},dca:{enabled:true,steps:2,distancePct:.1,multiplier:.2}}}
 const cached=new TradingEngine(settings);let reference=new TradingEngine(settings),changes=0,last=-1
 for(let i=0;i<280;i++){
  if(i===140){cached.updateSettings({stageMinPF:{base:.9,main:.9,real:.9},coordinations:{...settings.coordinations,axis:{...settings.coordinations.axis,outcome:'negative'}}});reference.updateSettings(cached.settings)}
  const close=100+10*Math.sin(i/5)+2*Math.sin(i/13),bar={timestamp:1790000040000+i*60000,open:close,high:close,low:close,close,volume:1}
  assert.deepEqual(cached.processCandles('BTC-USDT',[bar]),reference.processCandles('BTC-USDT',[bar]))
  assert.deepEqual(cached.snapshot().stages,reference.snapshot().stages)
  const q=cached.snapshot().stages[0].currentQualified;if(q!==last){changes++;last=q}
  reference=TradingEngine.fromSerialized(reference.serializeState())
 }
 assert.ok(changes>4);assert.deepEqual(clean(cached.exportState()),clean(reference.exportState()))
})
