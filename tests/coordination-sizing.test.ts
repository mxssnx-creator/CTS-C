import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'
import {observedExit} from '../core/exits'
import {generateStrategyCatalog} from '../core/catalog'
const start=1700000040000
const bars=Array.from({length:1500},(_,i)=>{const close=100+7*Math.sin(i/8);return {timestamp:start+i*60000,open:close,high:close,low:close,close,volume:1}})
const catalog={strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['trailing'],strategyIndicationTypes:['MA_Cross']}

test('a confirmed trail cannot deactivate or loosen when a Block add raises weighted entry',()=>{
 const first=observedExit({direction:'long',entryPrice:100,peak:100,price:102,takeProfitPct:1,stopLossPct:.5,exitMode:'trailing',openedAt:start,timestamp:start+1,maxHoldMinutes:60})
 assert.equal(first.trailingActive,true)
 const after=observedExit({direction:'long',entryPrice:101.8,peak:first.peak,price:101.9,takeProfitPct:1,stopLossPct:.5,exitMode:'trailing',openedAt:start,timestamp:start+2,maxHoldMinutes:60,trailingActive:first.trailingActive,trailingStopPrice:first.stop})
 assert.equal(after.trailingActive,true);assert.ok(after.stop>=first.stop)
 const short=observedExit({direction:'short',entryPrice:98.2,peak:98,price:98.1,takeProfitPct:1,stopLossPct:.5,exitMode:'trailing',openedAt:start,timestamp:start+2,maxHoldMinutes:60,trailingActive:true,trailingStopPrice:98.49})
 assert.equal(short.trailingActive,true);assert.ok(short.stop<=98.49)
})

test('coordination volume ratios scale recorded budget and PnL without manufacturing PF',()=>{
 const make=(factor:number)=>new TradingEngine({symbols:['BTC-USDT'],catalog,stageLastN:{base:2,main:2,real:2},stageMinPF:{base:0,main:0,real:0},volumeRatios:{normal:1,axis:factor,block:1,dca:1}})
 const low=make(1),high=make(3)
 low.processCandles('BTC-USDT',bars);high.processCandles('BTC-USDT',bars)
 for(const stage of ['base','main','real','live']){
  const a=low.coordinationStats().find(s=>s.stage===stage&&s.coordination==='axis')!,b=high.coordinationStats().find(s=>s.stage===stage&&s.coordination==='axis')!
  assert.equal(a.closed,b.closed);assert.ok(Math.abs(a.profitFactor-b.profitFactor)<1e-10);assert.ok(Math.abs(b.netPnl-a.netPnl*3)<1e-9)
 }
 assert.deepEqual(low.snapshot().trades.filter(t=>t.coordination==='normal'),high.snapshot().trades.filter(t=>t.coordination==='normal'))
})

test('TP, SL, trail and hold factors have explicit independent economics and reject invalid prices',()=>{
 const base=generateStrategyCatalog('x',catalog)[0],changed=generateStrategyCatalog('x',{...catalog,strategyTpFactor:2,strategySlFactor:.5,strategyTrailRatio:.4,holdTimeFactor:2})[0]
 assert.equal(changed.takeprofit,base.takeprofit*2);assert.equal(changed.stoploss,base.stoploss);assert.ok(Math.abs(changed.trailDistancePct!-base.stoploss*100*.4)<1e-12)
 assert.equal(changed.maxHoldMinutes,base.maxHoldMinutes!*2);assert.notEqual(changed.id,base.id)
 assert.throws(()=>generateStrategyCatalog('x',{strategyTpFactor:10,strategySlFactor:10}),/distances/)
})

test('per-symbol exchange fees affect only their own economics and retired fee cohorts cannot stay current',()=>{
 const engine=new TradingEngine({symbols:['BTC-USDT','ETH-USDT'],catalog,symbolFees:{'BTC-USDT':{makerFeePct:.02,takerFeePct:.05},'ETH-USDT':{makerFeePct:.02,takerFeePct:.08}}})
 for(const candle of bars){engine.processCandles('BTC-USDT',[candle]);if(engine.snapshot({laneLimit:0}).positions.length)break}
 engine.processCandles('ETH-USDT',bars.slice(0,400))
 const before=engine.exportState(),btc=Object.values(before.lanes).filter(l=>l.symbol==='BTC-USDT'),eth=Object.values(before.lanes).filter(l=>l.symbol==='ETH-USDT')
 assert.ok(btc.length&&eth.length);assert.ok(Math.abs(btc[0].config.roundTripCostPct!-.11)<1e-12);assert.ok(Math.abs(eth[0].config.roundTripCostPct!-.176)<1e-12)
 engine.updateSettings({symbolFees:{'BTC-USDT':{makerFeePct:.02,takerFeePct:.08},'ETH-USDT':{makerFeePct:.02,takerFeePct:.05}}})
 assert.equal(engine.coordinationStats().reduce((sum,r)=>sum+r.lanes,0),0,'a config currently used by another symbol cannot legitimize a retired fee cohort')
 const first=btc.find(l=>l.open)!.open!
 assert.ok(Math.abs(first.costPct-.11)<1e-12)
})
