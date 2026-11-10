import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'
import {aggregateCostNormalizedResults} from '../core/metrics'
const bars=Array.from({length:1400},(_,i)=>{const close=100+8*Math.sin(i/17);return {timestamp:1700000040000+i*60000,open:close,high:close,low:close,close,volume:1}})
test('post-Base metrics use immutable own-parent admission proof and retain subsequent losses',()=>{
 const engine=new TradingEngine({symbols:['BTC-USDT'],stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
 const events=engine.processCandles('BTC-USDT',bars,{allowExecution:true})
 for(const stage of ['main','real','live'] as const){
  const trades=events.filter(e=>e.stage===stage&&e.trade).map(e=>e.trade!),required=['main','real','live'].indexOf(stage)+1
  assert.ok(trades.length);assert.ok(trades.some(t=>t.netReturnPct<0))
  for(const trade of trades){
   assert.equal(trade.admission!.length,required)
   for(const proof of trade.admission!){assert.equal(proof.qualified,true);assert.ok(proof.count>=proof.required);assert.equal(proof.checkedAt,trade.openedAt);assert.ok(proof.laneId.includes(trade.configId));assert.ok(proof.laneId.includes(trade.coordination))}
  }
  const actual=engine.snapshot({laneLimit:0,positionLimit:0}).stages.find(s=>s.stage===stage)!.admittedForward!
  assert.equal(actual.closes,trades.length);assert.ok(Math.abs(actual.profitFactor-aggregateCostNormalizedResults(trades.map(t=>t.netReturnPct)).profitFactor)<1e-10)
  assert.equal(actual.unprovenCloses,0)
 }
 const before=engine.snapshot({laneLimit:0,positionLimit:0}).stages.map(s=>s.admittedForward)
 engine.updateSettings({volumeFactor:.002})
 assert.deepEqual(engine.snapshot({laneLimit:0,positionLimit:0}).stages.map(s=>s.admittedForward),before,'retiring cohorts cannot erase their forward results')
 assert.ok(engine.pendingIntents().every(i=>Boolean(i.qualificationId)))
})
