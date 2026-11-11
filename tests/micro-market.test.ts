import assert from 'node:assert/strict'
import {test} from 'node:test'
import {gzipSync} from 'node:zlib'
import {generateStrategyCatalog} from '../core/catalog'
import {resolveTradingCostPct} from '../core/metrics'
import {TradeBarBuilder,decodeTradeMessage,BingxTradeStream,TRADE_STREAM_URLS} from '../core/trade-stream'
import {TradingEngine} from '../core/engine'
import {blockRoundBudget,consumeBlockPause,settleBlockRound} from '../core/block-rounds'
import {DEFAULTS,configurationCount} from '../core/settings-schema'
import {observedExit} from '../core/exits'
import {StateStore} from '../core/store'
import type {LaneState} from '../core/types'

test('Micro/Low-Range Cartesian identity covers every step, tenth ratio, exit and timeframe',()=>{
  const settings={...DEFAULTS,strategyEnabledRanges:['Micro','Low-Range'],strategyTpSteps:[2,3,4,5],strategySlRatios:Array.from({length:15},(_,i)=>(i+2)/10),strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:['MA_Cross'],strategySignalTimeframes:[1/6,1]}
  const configs=generateStrategyCatalog('bingx-x02',settings)
  assert.equal(configs.length,720);assert.equal(new Set(configs.map(c=>c.id)).size,720)
  assert.equal(configurationCount(settings),configs.length)
  for(const c of configs){assert.ok(Math.abs(c.roundTripCostPct!-.11)<1e-12);assert.ok(Math.abs(c.stoploss/c.takeprofit-c.slRatio!)<1e-12);assert.ok(Math.abs(c.trailDistancePct!-c.stoploss*50)<1e-12)}
})
test('maker/taker costs charge two execution legs and fee-relative slippage exactly once',()=>{
  assert.ok(Math.abs(resolveTradingCostPct()-.11)<1e-12)
  assert.equal(resolveTradingCostPct({slippagePctOfFees:0}),.1)
  assert.equal(resolveTradingCostPct({entryLiquidity:'maker',exitLiquidity:'maker',slippagePctOfFees:0}),.04)
  assert.equal(resolveTradingCostPct({entryLiquidity:'maker',exitLiquidity:'taker',slippagePctOfFees:0}),.07)
})
test('trade arrays preserve IDs and volumes; complete 10s bars reject duplicates, late trades and gap interpolation',()=>{
  const raw={code:0,dataType:'BTC-USDT@trade',data:[{t:'2106395788706476032',s:'BTC-USDT',T:10001,p:'100',q:'2'},{t:'2106395788706476033',s:'BTC-USDT',T:10002,p:'101',q:'3'}]}
  const bytes=gzipSync(JSON.stringify(raw)),parsed=decodeTradeMessage(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))
  assert.notEqual(parsed,'Ping');if(parsed==='Ping')return
  assert.equal(parsed[0].id,raw.data[0].t)
  const idless=decodeTradeMessage(JSON.stringify({...raw,data:raw.data.map(({t,...row})=>row)}));assert.notEqual(idless,'Ping');if(idless!=='Ping')assert.ok(idless.every(t=>t.id===null))
  const b=new TradeBarBuilder();for(const t of parsed)b.ingest(t)
  assert.equal(b.ingest(parsed[0]).accepted,false)
  const first=b.ingest({...parsed[0],id:'next',timestamp:20001,price:102}).bar!
  assert.equal(first.complete,false);assert.equal(first.volume,5)
  const second=b.ingest({...parsed[0],id:'third',timestamp:30001,price:99}).bar!
  assert.equal(second.complete,true);assert.equal(second.timestamp,30000)
  assert.equal(b.ingest({...parsed[0],id:'late',timestamp:20002}).accepted,false)
  assert.equal(b.ingest({...parsed[0],id:'gap',timestamp:50001}).bar!.complete,false)
  const store=new StateStore(':memory:');store.saveTradeBar('BTC-USDT',second);store.saveTradeBar('BTC-USDT',second);assert.deepEqual(store.tradeBars('BTC-USDT'),[second]);store.close()
})
test('10s and 1m clocks create independent signal evidence and survive restart',()=>{
  const e=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyTpSteps:[2],strategySlRatios:[.3],strategyEnabledRanges:['Micro'],strategyIndicationTypes:['Trend'],strategySignalTimeframes:[1/6,1],strategyExitModes:['fixed']}})
  const bars=Array.from({length:100},(_,i)=>{const price=100+Math.sin(i/5);return {timestamp:1790000000000+i*10000,open:price,high:price,low:price,close:price,volume:10}})
  e.processCandles('BTC-USDT',bars,{barSeconds:10})
  assert.equal(e.lastProcessedAt('BTC-USDT'),null);assert.equal(e.lastProcessedAt('BTC-USDT',10),bars.at(-1)!.timestamp)
  assert.ok(Object.values(e.exportState().lanes).every(l=>l.config.signalTimeframeMinutes===1/6))
  const restored=TradingEngine.fromSerialized(e.serializeState());assert.deepEqual(restored.processCandles('BTC-USDT',bars,{barSeconds:10}),[])
})
test('auto PF uses cost-adjusted distance at each configuration without dropping stage floors',()=>{
  const c=generateStrategyCatalog('x',{strategyEnabledRanges:['Micro'],strategyTpSteps:[2,5],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend'],autoPfEnabled:true,autoPfRatio:1,autoPfMax:2})
  assert.equal(c[0].autoPfFloor,1.2);assert.equal(c[1].autoPfFloor,1.5)
})
test('current micro trades cannot close minute positions still inside historical warmup',()=>{
  const e=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyEnabledRanges:['Micro'],strategyTpSteps:[2],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend'],strategySignalTimeframes:[1]}})
  const start=1790000000000
  for(let i=0;i<50;i++){const close=100+i*.01;e.processCandles('BTC-USDT',[{timestamp:start+i*60000,open:close,high:close,low:close,close,volume:1}])}
  const before=e.exportState().lanes;assert.ok(Object.values(before).some(l=>l.open))
  e.processTick('BTC-USDT',120,start+100*60000,true,'micro')
  assert.deepEqual(e.exportState().lanes,before)
  e.processCandles('BTC-USDT',[{timestamp:start+101*60000,open:120,high:120,low:120,close:120,volume:1}],{barSeconds:10})
  assert.deepEqual(e.exportState().lanes,before,'10s candle closes also cannot settle minute warmup positions')
  assert.ok(e.processTick('BTC-USDT',120,start+100*60000,true).some(e=>e.type==='closed'))
})
test('Block rounds increase all N subsequent positions, retain unrecovered losses, cap and pause independently',()=>{
  const lane={} as LaneState,other={} as LaneState,policy={enabled:true,behavior:'rounds' as const,size:3,pauseRounds:1,steps:3,ratio:.2,mode:'additive' as const,maxMultiplier:1.4}
  for(const pnl of [-1,-1,-1])settleBlockRound(lane,pnl,policy)
  assert.equal(blockRoundBudget(lane,policy),1.2);assert.equal(blockRoundBudget(other,policy),1)
  for(const pnl of [.1,.1,.1])settleBlockRound(lane,pnl,policy)
  assert.equal(blockRoundBudget(lane,policy),1.2,'positive round cannot reset unrecovered net loss')
  for(const pnl of [-1,-1,-1])settleBlockRound(lane,pnl,policy)
  assert.equal(blockRoundBudget(lane,policy),1.4)
  for(const pnl of [3,3,3])settleBlockRound(lane,pnl,policy)
  assert.equal(blockRoundBudget(lane,policy),0)
  for(let i=0;i<3;i++)assert.equal(consumeBlockPause(lane,policy),true)
  assert.equal(consumeBlockPause(lane,policy),false);assert.equal(blockRoundBudget(lane,policy),1)
})
test('thin trailing ratchets at actual observations on both directions',()=>{
  for(const direction of ['long','short'] as const){const sign=direction==='long'?1:-1
    const p={direction,entryPrice:100,peak:100,price:100+sign*.3,takeProfitPct:.22,stopLossPct:.11,trailDistancePct:.055,exitMode:'trailing' as const,openedAt:1,timestamp:2,maxHoldMinutes:15}
    const armed=observedExit(p);assert.equal(armed.trailingActive,true)
    const closed=observedExit({...p,peak:armed.peak,price:100+sign*.2,timestamp:3,trailingActive:true,trailingStopPrice:armed.stop})
    assert.equal(closed.reason,'trailing_stop');assert.equal(closed.stop,armed.stop)
  }
})
test('an ordered new trade in the entry millisecond manages a stop while the entry candle cannot close itself',()=>{
  const e=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyEnabledRanges:['Micro'],strategyTpSteps:[2],strategySlRatios:[.2],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
  let opened:ReturnType<TradingEngine['snapshot']>['positions'][number]|undefined
  for(let i=0;i<100&&!opened;i++){const price=100+i*.01;e.processCandles('BTC-USDT',[{timestamp:1790000000000+i*60000,open:price,high:price,low:price,close:price,volume:1}]);opened=e.snapshot().positions[0]}
  assert.ok(opened)
  const price=opened.entryPrice*(opened.direction==='long'?.99:1.01)
  assert.deepEqual(e.processTick('BTC-USDT',price,opened.openedAt),[])
  assert.ok(e.processTick('BTC-USDT',price,opened.openedAt,true).some(event=>event.type==='closed'))
})
test('each of the three 50-symbol WebSockets has an independent heartbeat and reconnect resets queued continuity',t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1790000000000})
  const sockets:any[]=[],urls:string[]=[]
  const stream=new BingxTradeStream('bingx-x02',url=>{urls.push(url);const socket={sent:[] as string[],send(data:string){this.sent.push(data)},close(){},onopen:null,onmessage:null,onclose:null,onerror:null};sockets.push(socket);return socket as unknown as WebSocket})
  try{
    stream.start(Array.from({length:50},(_,i)=>`B${i}-USDT`));for(const socket of sockets)socket.onopen()
    assert.equal(stream.status.connected,true);assert.deepEqual(sockets.map(s=>s.sent.length),[20,20,10]);assert.ok(urls.every(u=>u===TRADE_STREAM_URLS['bingx-x02']))
    t.mock.timers.tick(29000);sockets[0].onmessage({data:'Ping'});assert.equal(sockets[0].sent.at(-1),'Pong')
    sockets[0].onmessage({data:JSON.stringify({code:0,dataType:'B0-USDT@trade',data:[{s:'B0-USDT',T:Date.now(),p:'100',q:'1'}]})})
    assert.equal(stream.status.received,1)
    t.mock.timers.tick(6000)
    assert.equal(stream.status.connected,false);assert.equal(stream.status.reconnects,1);assert.match(stream.status.error!,/heartbeat/);assert.deepEqual(stream.drain(),[])
    t.mock.timers.tick(2000);assert.equal(sockets.length,6)
  }finally{stream.stop();t.mock.timers.reset()}
})
