import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateStrategyCatalog} from '../core/catalog'
import {TradingEngine} from '../core/engine'
import {observedExit} from '../core/exits'
import {validateConfiguration,DEFAULTS} from '../core/settings-schema'

test('Micro floors are independent of other ranges, costs and captured held economics',()=>{
 const common={strategyEnabledRanges:['Micro','Minimal','Short','Low-Range'],strategyTpSteps:[2,6,9],strategySlRatios:[.2,1.6],strategyExitModes:['fixed','trailing-only'],strategyIndicationTypes:['Trend']}
 const before=generateStrategyCatalog('x',common,'2026-11-12T00:00:00Z'),after=generateStrategyCatalog('x',{...common,microMinSlDistancePct:.18,microMinTrailDistancePct:.09},'2026-11-12T00:00:00Z')
 for(let i=0;i<before.length;i++){
  const a=before[i],b=after[i]
  assert.equal(a.takeprofit,b.takeprofit);assert.equal(a.roundTripCostPct,b.roundTripCostPct)
  if(['Micro','Low-Range'].includes(b.range!)){assert.ok(b.stoploss>=.0018);assert.ok(b.trailDistancePct!>=.09)}else assert.deepEqual(a,b)
 }
 const engine=new TradingEngine({symbols:['BTC-USDT'],catalog:common}),start=1790000000000
 for(let i=0;i<60;i++){const close=100+i*.01;engine.processCandles('BTC-USDT',[{timestamp:start+i*60000,open:close,high:close,low:close,close,volume:1}])}
 const held=engine.snapshot().positions;assert.ok(held.length)
 engine.updateSettings({catalog:{...common,microMinSlDistancePct:.8,microMinTrailDistancePct:.4}})
 assert.deepEqual(engine.snapshot().positions,held)
 assert.deepEqual(TradingEngine.fromSerialized(engine.serializeState()).snapshot().positions,held)
})
test('floor validation and the same long/short observed trailing exits retain the exact gap',()=>{
 assert.equal(validateConfiguration({...DEFAULTS}).microMinSlDistancePct,.1)
 for(const value of [-1,NaN,Infinity,11])assert.throws(()=>generateStrategyCatalog('x',{microMinSlDistancePct:value}))
 for(const direction of ['long','short'] as const){const sign=direction==='long'?1:-1,c=generateStrategyCatalog('x',{strategyEnabledRanges:['Micro'],strategyTpSteps:[2],strategySlRatios:[.2],strategyExitModes:['trailing-only'],strategyIndicationTypes:['Trend'],microMinSlDistancePct:.18,microMinTrailDistancePct:.09})[0]
  const entry={direction,entryPrice:100,peak:100,price:100+sign*.3,takeProfitPct:c.takeprofit*100,stopLossPct:c.stoploss*100,trailDistancePct:c.trailDistancePct,exitMode:'trailing-only' as const,openedAt:1,timestamp:2,maxHoldMinutes:15,trailingBasis:'entry' as const}
  const first=observedExit(entry);assert.ok(Math.abs(Math.abs(first.peak-first.stop)-.09)<1e-10)
  assert.equal(observedExit({...entry,peak:first.peak,price:first.stop-sign*.001,timestamp:3,trailingActive:true,trailingStopPrice:first.stop}).reason,'trailing_stop')
 }
})
