import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {SIGNAL_SOURCES,SIGNALS_CATALOG,DEFAULT_SIGNALS_SOURCES,signalsCoordinationId} from '../shared/cts-indications/signals-catalog'
import {portedStates,entryOnsets} from '../shared/cts-indications/index'
import {signalCoordinationId,signalCoordinationVoteCounts,signalCoordinationStateFromVotes} from '../shared/cts-indications/origin/signal-coordination'
import {waveBars} from '../shared/cts-indications/fixtures'
import {advanceConfiguredSignal,newSignalState} from '../core/replay'
import {generateStrategyCatalog} from '../core/catalog'
import {TradingEngine,windowMetrics} from '../core/engine'
import {DEFAULTS,validateConfiguration,configurationCount,hydrate} from '../core/settings-schema'
import {LEGACY_INDICATIONS} from '../core/indications'

test('all 103 Signals source families and 225 disjoint coordinators keep their pinned oracle states',()=>{
 assert.equal(SIGNAL_SOURCES.length,103);assert.equal(SIGNALS_CATALOG.length,431)
 const ids=SIGNALS_CATALOG.map(s=>s.id);assert.equal(new Set(ids).size,ids.length)
 const data=portedStates('BTC-USDT',1,waveBars(600),ids),hash=createHash('sha256')
 for(const id of ids){assert.equal(data.available[id],true);hash.update(id);hash.update(data.states[id]);assert.ok(data.states[id].every(v=>[-1,0,1].includes(v)))}
 assert.equal(hash.digest('hex'),'ec8e903b2a95632523083cecc33795b6540ba301457716237e86ec34a8768467')
 const names=['ema-cross','rsi-momentum','donchian','adx','vwap'];for(const ratio of [.6,.65,.7,.75,.8])for(const min of [2,3,5])for(const mask of [1,2,3])assert.equal(signalsCoordinationId(names,ratio,min,mask),signalCoordinationId(names,ratio as .6,min,mask as 1))
})
test('Signals abstain on conflicting variants and vote once per source with exact band boundaries',()=>{
 const counts=signalCoordinationVoteCounts([[Int8Array.of(1),Int8Array.of(-1)],[Int8Array.of(1),Int8Array.of(1)],[Int8Array.of(-1)]],1)
 assert.deepEqual([...counts.positive],[1]);assert.deepEqual([...counts.negative],[1])
 const votes={positive:Uint8Array.of(3,4,0),negative:Uint8Array.of(2,1,5)}
 assert.deepEqual([...signalCoordinationStateFromVotes(votes,.6,3)],[1,0,0]);assert.deepEqual([...signalCoordinationStateFromVotes(votes,.8,3)],[0,1,-1])
 assert.deepEqual([...signalCoordinationStateFromVotes(votes,.8,6)],[0,0,0])
})
test('Signals completed-bar onsets agree with causal prefixes, batches and restored state',()=>{
 const rows=waveBars(260),ids=SIGNALS_CATALOG.map(s=>s.id),full=portedStates('BTC-USDT',1,rows,ids)
 for(const n of [70,130,200]){const prefix=portedStates('BTC-USDT',1,rows.slice(0,n),ids);for(const id of ids)assert.deepEqual(prefix.states[id],full.states[id].slice(0,n))}
 for(const id of [DEFAULT_SIGNALS_SOURCES[0],DEFAULT_SIGNALS_SOURCES.at(-1)!]){
  const expected=entryOnsets(full.states[id]),config={type:'Signals',position_cost_step:20,indicationSourceId:id,signalTimeframeMinutes:1};let state=newSignalState()
  for(let i=0;i<rows.length;i++){if(i===140)state=JSON.parse(JSON.stringify(state));const signal=advanceConfiguredSignal(state,{...rows[i],timestamp:rows[i].timestamp+60000},config,{symbol:'BTC-USDT'});assert.equal(signal,expected[i]>0?'long':expected[i]<0?'short':undefined)}
 }
})
test('Signals Settings, all short ranges, source/TF/exit identities and risk cohorts remain independent',()=>{
 const v=validateConfiguration({...DEFAULTS,strategyIndicationTypes:['Signals'],strategySignalsSources:DEFAULT_SIGNALS_SOURCES.slice(0,2),strategyEnabledRanges:['Micro','Low-Range','Minimal','Short'],strategyTpSteps:[2,3,5,8,12],strategySlRatios:[.2,1],strategySignalTimeframes:[1/6,1,5],strategyExitModes:['fixed','trailing','trailing-only']})
 const configs=generateStrategyCatalog('test',v);assert.equal(configs.length,configurationCount(v));assert.equal(configs.length,new Set(configs.map(c=>c.id)).size)
 for(const range of ['Micro','Low-Range','Minimal','Short'])for(const mode of ['fixed','trailing','trailing-only'])assert.ok(configs.some(c=>c.range===range&&c.exitMode===mode))
 assert.deepEqual(hydrate(Object.fromEntries(Object.entries(v).map(([k,value])=>[k,typeof value==='object'?JSON.stringify(value):String(value)]))),v)
 assert.throws(()=>generateStrategyCatalog('x',{...v,strategySignalsSources:['sig-made-up']}),/Signals/)
 const noRisk=generateStrategyCatalog('test',{...v,signalsMaxWindowDrawdownPct:0});assert.ok(noRisk.every(c=>!configs.some(old=>old.id===c.id)))
 const old={strategyIndicationTypes:[...LEGACY_INDICATIONS],strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed']}
 assert.deepEqual(generateStrategyCatalog('x',old,'fixed'),generateStrategyCatalog('x',{...old,strategySignalsSources:DEFAULT_SIGNALS_SOURCES.slice(0,1),signalsMaxWindowDrawdownPct:1},'fixed'))
})
test('own chronological return-drawdown gates reject a positive-PF bad path without altering sample sufficiency',()=>{
 const lane:any={config:{maxWindowDrawdownPct:1},samples:[3,-2,-2,3],closedCount:4}
 const blocked=windowMetrics(lane,4,1.1);assert.equal(blocked.profitFactor,1.5);assert.equal(blocked.drawdownPct,4);assert.equal(blocked.enoughSamples,true);assert.equal(blocked.qualified,false)
 lane.config.maxWindowDrawdownPct=5;assert.equal(windowMetrics(lane,4,1.1).qualified,true,'cache must include the risk cap')
 lane.config.maxWindowDrawdownPct=undefined;assert.equal(windowMetrics(lane,4,1.1).drawdownPct,undefined)
})
test('Signals additional strategies keep own processed-stage evidence, parent links and restart continuity with Normal disabled',()=>{
 const rows=waveBars(800).map(b=>({...b,timestamp:b.timestamp+60000})),catalog={strategyIndicationTypes:['Signals'],strategySignalsSources:['sig-ema-cross-s'],strategyEnabledRanges:['Micro','Low-Range'],strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyNormalEnabled:false,signalsMaxWindowDrawdownPct:0}
 const settings={symbols:['BTC-USDT'],catalog,stageGateMode:'processed-sets' as const,liveEntryMode:'real-mirror' as const,stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0}}
 const full=new TradingEngine(settings),split=new TradingEngine(settings);full.processCandles('BTC-USDT',rows);split.processCandles('BTC-USDT',rows.slice(0,350));const restored=new TradingEngine({},split.exportState());restored.processCandles('BTC-USDT',rows.slice(350))
 const clean=(e:TradingEngine)=>{const s=e.exportState();return {lanes:s.lanes,trades:s.recentLiveTrades,signals:s.signals,last:s.lastTimestamp}}
 assert.deepEqual(clean(full),clean(restored));const state=full.exportState(),live=state.recentLiveTrades!
 assert.ok(live.length);assert.ok(live.every(t=>t.coordination!=='normal'&&t.parentPositionId&&t.admission?.length===3))
 for(const t of live)for(const proof of t.admission!)assert.ok(proof.laneId.includes(t.configId)&&proof.laneId.includes(t.coordination))
})
