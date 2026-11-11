import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine,validateEngineSettings} from '../core/engine'
import {generateStrategyCatalog} from '../core/catalog'
import {advancePortedSources,advanceConfiguredSignal,newSignalState,PORTED_HISTORY_LIMIT,replayStrategy} from '../core/replay'
import {DEFAULTS,configurationCount,validateConfiguration} from '../core/settings-schema'
import {runTerminalReplay} from '../core/terminal-replay'
import {INDICATIONS} from '../core/indications'
import {portedStates} from '../shared/cts-indications'
import {PORTED_CATALOG,DEFAULT_INVERSE_SOURCES,DEFAULT_TACTIC_SOURCES} from '../shared/cts-indications/catalog'
import {waveBars} from '../shared/cts-indications/fixtures'
import type {Candle} from '../core/types'

const rows=waveBars(720)
const bars:Candle[]=rows.map(b=>({...b,timestamp:b.timestamp+60000}))
const noAdjustments={axis:{enabled:false,previous:2,last:1,outcome:'any' as const},block:{enabled:false,steps:2,ratio:.2,mode:'shared' as const},dca:{enabled:false,steps:2,distancePct:1,multiplier:2}}

test('every indication source, range, exit, ratio, period and supported timeframe remains represented without truncation',()=>{
 const ranges=['Micro','Minimal','Short','Normal','Long','Wide'],steps=[3,8,12,18,24,30]
 for(const [i,range] of ranges.entries()){
  const settings={...DEFAULTS,strategyEnabledRanges:[range],strategyTpSteps:[steps[i]],strategySlRatios:[.2,1,2.2],strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:[...INDICATIONS],strategyIndicationSources:PORTED_CATALOG.map(s=>s.id),strategySignalPeriods:[10,14,20,40,60],strategySignalTimeframes:[1,5,15,30]}
  const configs=generateStrategyCatalog('bingx-x02',settings)
  assert.equal(configs.length,configurationCount(settings));assert.equal(new Set(configs.map(c=>c.id)).size,configs.length)
  assert.ok(configs.every(c=>c.range===range&&c.takeprofit>0&&c.stoploss>0))
  const sources=new Set(configs.map(c=>c.indicationSourceId).filter(Boolean))
  for(const source of PORTED_CATALOG)assert.ok(sources.has(source.id),source.id+'/'+range)
  for(const type of INDICATIONS)for(const exit of ['fixed','trailing','trailing-only'])assert.ok(configs.some(c=>c.type===type&&c.exitMode===exit),type+'/'+range+'/'+exit)
 }
})

test('all imported sources have distinct identities across supported timeframes and match the Settings count',()=>{
 const values={...DEFAULTS,strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Tactic','Inverse'],strategyIndicationSources:PORTED_CATALOG.map(s=>s.id),strategySignalTimeframes:[1,5,15,30]}
 const configs=generateStrategyCatalog('bingx-x02',values)
 assert.equal(configs.length,586*4+604*3)
 assert.equal(new Set(configs.map(c=>c.id)).size,configs.length)
 assert.equal(configurationCount(values),configs.length)
 assert.equal(configs.filter(c=>c.type==='Inverse'&&c.signalTimeframeMinutes===30).length,0)
 for(const type of ['Tactic','Inverse'])assert.ok(configs.some(c=>c.type===type&&c.signalTimeframeMinutes===15))
 assert.throws(()=>generateStrategyCatalog('bingx-x02',{...values,strategyIndicationSources:['unknown-source']}))
})

test('the close-time adapter matches the imported open-time oracle for every default source',()=>{
 const ids=[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES],expected=portedStates('SOL-USDT',1,rows,ids)
 const state=newSignalState(),actual=Object.fromEntries(ids.map(id=>[id,[] as number[]]))
 for(const bar of bars){const out=advancePortedSources(state,bar,1,ids,{symbol:'SOL-USDT'});for(const id of ids)actual[id].push(out.get(id)==='long'?1:out.get(id)==='short'?-1:0)}
 for(const id of ids)assert.deepEqual(actual[id],Array.from(expected.states[id]),id)
 assert.equal(state.portedBars![0].timestamp,rows[0].timestamp)
 assert.equal(state.portedBars!.at(-1)!.timestamp,rows.at(-1)!.timestamp)
})

test('one source history is shared across configurations, with independent engine/research results',()=>{
 const sources=['inverse-known-ema-9-21','inverse-zscore-20']
 const catalog={strategyTpSteps:[3,8],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Inverse'],strategyIndicationSources:sources,strategySignalTimeframes:[1,5]}
 const e=new TradingEngine({symbols:['SOL-USDT'],catalog,coordinations:noAdjustments,stageLastN:{base:250,main:250,real:250}})
 const events=e.processCandles('SOL-USDT',bars),state=e.exportState()
 assert.equal(Object.values(state.signals).filter(s=>s.portedBars).length,2,'history count follows timeframes, not source/configuration count')
 for(const config of generateStrategyCatalog('bingx-x02',catalog)){
  const actual=events.filter(e=>e.trade?.configId===config.id&&e.stage==='base').map(e=>e.trade!)
  const expected=replayStrategy('SOL-USDT',bars,config,5000).filter(p=>p.status==='closed')
  assert.equal(actual.length,expected.length)
  for(let i=0;i<actual.length;i++){assert.equal(actual[i].openedAt,Date.parse(expected[i].entry_time));assert.equal(actual[i].closedAt,Date.parse(expected[i].exit_time!));assert.equal(actual[i].direction,expected[i].direction);assert.ok(Math.abs(actual[i].netReturnPct-expected[i].result!)<1e-10)}
 }
 assert.ok(events.some(e=>e.trade?.stage==='base'),'the fixture must exercise actual trades')
})

test('bounded source history restarts exactly across rollover and incomplete higher candles emit nothing',()=>{
 const id='inverse-known-ema-9-21',config={type:'Inverse',position_cost_step:20,indicationSourceId:id,signalTimeframeMinutes:1}
 const state=newSignalState(),long=waveBars(PORTED_HISTORY_LIMIT+12).map(b=>({...b,timestamp:b.timestamp+60000}))
 for(const bar of long.slice(0,PORTED_HISTORY_LIMIT-2))advanceConfiguredSignal(state,bar,config)
 const restored=JSON.parse(JSON.stringify(state))
 assert.deepEqual(long.slice(PORTED_HISTORY_LIMIT-2).map(b=>advanceConfiguredSignal(state,b,config)),long.slice(PORTED_HISTORY_LIMIT-2).map(b=>advanceConfiguredSignal(restored,b,config)))
 assert.ok(state.portedBars!.length<=PORTED_HISTORY_LIMIT&&state.portedBars!.length>PORTED_HISTORY_LIMIT/2);assert.deepEqual(state,restored)
 const partial=newSignalState();assert.equal(advanceConfiguredSignal(partial,bars[1],{...config,signalTimeframeMinutes:5}),undefined);assert.equal(partial.portedBars,undefined)
})

test('source references exclude future observations and missing references stay inactive',()=>{
 const id='inverse-pair-btc-spread-20',own=bars.slice(0,200),peer=waveBars(300).map(b=>({...b,close:b.close*1.01,open:b.open*1.01,high:b.high*1.01,low:b.low*1.01}))
 const a=newSignalState(),b=newSignalState(),missing=newSignalState()
 for(const bar of own){
  const first=advancePortedSources(a,bar,1,[id],{symbol:'SOL-USDT',peers:[{symbol:'BTC-USDT',bars:peer}]}).get(id)
  const changed=peer.map(p=>p.timestamp>=bar.timestamp?{...p,open:p.open*10,high:p.high*10,low:p.low*10,close:p.close*10}:p)
  assert.equal(advancePortedSources(b,bar,1,[id],{symbol:'SOL-USDT',peers:[{symbol:'BTC-USDT',bars:changed}]}).get(id),first)
  assert.equal(advancePortedSources(missing,bar,1,[id],{symbol:'SOL-USDT'}).get(id),undefined)
 }
})

test('replay trace caches isolate source IDs and report which source actually passed training',()=>{
 const catalog={strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Inverse'],strategyIndicationSources:['inverse-known-ema-9-21','inverse-zscore-20'],mainEvalPosCount:1,replayBarSeconds:60}
 const input=rows.map(r=>({...r,time:r.timestamp/1000})),result=runTerminalReplay('SOL-USDT',input,catalog)
 assert.equal(result.rows.length,2)
 for(const row of result.rows){const single=runTerminalReplay('SOL-USDT',input,{...catalog,strategyIndicationSources:[row.indicationSourceId]});assert.deepEqual(row.training,single.rows[0].training);assert.deepEqual(row.holdout,single.rows[0].holdout);assert.ok(row.indicationSourceId)}
 assert.throws(()=>validateEngineSettings({catalog:{relationalVolumeRatios:{overall:-1}}}))
 assert.throws(()=>validateConfiguration({...DEFAULTS,strategyIndicationTypes:['Inverse'],strategySignalTimeframes:[30]}))
})
