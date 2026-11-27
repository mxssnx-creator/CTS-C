import {test} from 'node:test';import assert from 'node:assert/strict';import {portedStates,entryOnsets} from '../shared/cts-indications/index.ts';import {waveBars} from '../shared/cts-indications/fixtures.ts';import {advanceConfiguredSignal,newSignalState} from '../core/replay.ts';import {generateStrategyCatalog} from '../core/catalog.ts';import {DEFAULTS,configurationCount,validateConfiguration,hydrate} from '../core/settings-schema.ts';
import { RESEARCH_TACTIC_SOURCES } from '../shared/cts-indications/research-sources';
import { EXTRA_LOW_RANGE_SOURCES } from '../shared/cts-indications/low-range-catalog';
import { aggregateClosedBars } from '../shared/cts-indications/aligned';
import { PARABOLIC_SAR_VARIANTS, RSI_VARIANTS, THIN_OSCILLATOR_SOURCE_IDS } from '../shared/cts-indications/oscillator-sources';
test('ported entry events equal original AO Follow onsets on every closed candle and survive restart',()=>{
 for(const id of ['inverse-known-ema-9-21','inverse-zscore-20','tactic-dca-bounce-8-percent-0.5-1-0.25']){
  const rows=waveBars(320),expected=entryOnsets(portedStates('ASSET-USDT',1,rows,[id]).states[id]),s=newSignalState();let restored:ReturnType<typeof newSignalState>|undefined;
  for(let i=0;i<rows.length;i++){
   const c={...rows[i],timestamp:rows[i].timestamp+60000},cfg={type:id.startsWith('inverse')?'Inverse':'Tactic',indicationSourceId:id,signalTimeframeMinutes:1,position_cost_step:3};
   const value=advanceConfiguredSignal(s,c,cfg);assert.equal(value,expected[i]>0?'long':expected[i]<0?'short':undefined,id+' '+i);
   if(restored)assert.equal(advanceConfiguredSignal(restored,c,cfg),value);
   if(i===160)restored=JSON.parse(JSON.stringify(s));
  }
 }
});
test('Tactic and Inverse catalog expansion preserves own source identities, timeframe gates, and saved controls',()=>{
 const cfg={...DEFAULTS,strategyShortStopPcts:[.3],strategyIndicationTypes:['Tactic','Inverse'],strategyIndicationSources:['inverse-known-ema-9-21','tactic-dca-sweep-20-percent-0.5-2-0.25'],strategySignalTimeframes:[1,5,15,30],strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed']};
 const v=validateConfiguration(cfg);assert.deepEqual(hydrate(Object.fromEntries(Object.entries(v).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]))),v);
 const configs=generateStrategyCatalog('test',v);assert.equal(configs.length,7);assert.equal(configurationCount(v),7);assert.equal(new Set(configs.map(c=>c.id)).size,7);assert.ok(configs.every(c=>c.indicationSourceId));assert.ok(configs.filter(c=>c.type==='Inverse').every(c=>c.signalTimeframeMinutes!==30));
});

test("Low-Range ports each source and supported timeframe into its own Low-Range Set", () => {
 const ids = ["low-range-6-edge-turn-standalone", "low-range-6-breakout-activity"]
 const settings = validateConfiguration({
  ...DEFAULTS, strategyShortStopPcts:[.3], strategyIndicationTypes: ["Low-Range"], strategyLowRangeSources: ids,
  strategyEnabledRanges: ["Micro", "Low-Range"], strategySignalTimeframes: [1, 5, 15, 30],
  strategyTpSteps: [2, 6, 8], strategySlRatios: [1], strategyExitModes: ["trailing", "trailing-fixed"],
 })
 const catalog = generateStrategyCatalog("test", settings)
 assert.equal(catalog.length, 24)
 assert.equal(configurationCount(settings), catalog.length)
 assert.equal(new Set(catalog.map(config => config.id)).size, catalog.length)
 assert.ok(catalog.every(config => config.range === "Low-Range" && config.tpStep !== 8 && config.signalTimeframeMinutes !== 30))
 assert.throws(() => validateConfiguration({...settings, strategyLowRangeSources: ["low-range-invalid"]}), /Choose valid/)
 const bars = waveBars(320)
 const output = portedStates("ASSET-USDT", 1, bars, ids)
 assert.ok(ids.every(id => output.available[id]))
 assert.ok(output.states[ids[0]].some(side => side !== 0))
 assert.equal(portedStates("ASSET-USDT", 30, bars, ids).available[ids[0]], false)
 for (const id of ids) {
  const state = newSignalState(), onsets = entryOnsets(output.states[id])
  const config = catalog.find(item => item.indicationSourceId === id && item.signalTimeframeMinutes === 1)!
  assert.deepEqual(bars.map(bar => advanceConfiguredSignal(state, {...bar, timestamp: bar.timestamp + 60000}, config)),
   Array.from(onsets, side => side > 0 ? "long" : side < 0 ? "short" : undefined))
 }
})

test("standard lookbacks and research ports produce distinct Sets with exact timeframe coverage", () => {
  const sources = RESEARCH_TACTIC_SOURCES.map(source=>source.id)
  const lowRange = EXTRA_LOW_RANGE_SOURCES.map(source=>source.id)
  assert.equal(lowRange.length,54)
  const settings = validateConfiguration({...DEFAULTS,strategyEnabledRanges:["Micro","Low-Range"],
    strategyIndicationTypes:["RSI_Band","MA_Cross","Tactic","Low-Range"],strategySignalTimeframes:[1,60],
    strategyCoreSignalPeriods:[0,5,8,14,20],strategyIndicationSources:sources,strategyLowRangeSources:lowRange,
    strategyTpSteps:[2],strategySlRatios:[.2],strategyExitModes:["fixed","trailing-fixed"]})
  const configs = generateStrategyCatalog("test",settings)
  assert.equal(configs.length,configurationCount(settings))
  assert.equal(new Set(configs.map(config=>config.id)).size,configs.length)
  const lookbacks = (type:string) => new Set(configs.filter(config=>config.type===type).map(config=>config.position_cost_step))
  assert.deepEqual(lookbacks("MA_Cross"),new Set([20,5,8,14]))
  assert.deepEqual(lookbacks("RSI_Band"),new Set([14,5,8,20]))
  assert.ok(configs.every(config=>config.signalTimeframeMinutes!==60||config.type!=="Low-Range"&&!config.indicationSourceId?.startsWith("r-qh-")))
  const bars = waveBars(480)
  const input = [...sources,...lowRange]
  const full = portedStates("SOL-USDT",1,bars,input)
  const prefix = portedStates("SOL-USDT",1,bars.slice(0,240),input)
  for (const id of input) { assert.ok(full.available[id]); assert.deepEqual(prefix.states[id],full.states[id].slice(0,240),id) }
  const rows = bars.map((bar,index)=>({...bar,timestamp:Math.floor(bars[0].timestamp/3_600_000)*3_600_000+index*60_000}))
  const hourly = portedStates("SOL-USDT",60,aggregateClosedBars(rows,60).bars,["rsi-mom-14-25","r-qh-flow"])
  assert.equal(hourly.states["rsi-mom-14-25"].length,8)
  assert.equal(hourly.available["r-qh-flow"],false)
})

test("Wilder RSI reclaim and momentum trigger differently and SAR acceleration keeps its own state", () => {
  assert.equal(RSI_VARIANTS.length,50)
  assert.equal(PARABOLIC_SAR_VARIANTS.length,20)
  const start = 1790000040000
  const prices = [100,99,98,97,96,95,98,101,104,107,106,105,101,97,94,90,93,98]
  const candles = prices.map((close,index)=>({timestamp:start+index*60_000,open:close,high:close+.2,low:close-.2,close,volume:1}))
  const ids = ["rsi-reclaim-5-25","rsi-mom-5-25","parabolic-sar-0.005-0.1","sar-fast"]
  const output = portedStates("ETH-USDT",1,candles,ids).states
  assert.equal(entryOnsets(output[ids[0]])[6],1,"RSI escapes 25 before it crosses 75")
  assert.equal(entryOnsets(output[ids[1]])[6],0)
  assert.equal(entryOnsets(output[ids[1]])[9],1)
  assert.notDeepEqual(output[ids[2]],output[ids[3]])
  assert.ok(output[ids[3]].includes(1)&&output[ids[3]].includes(-1))
  const settings = validateConfiguration({...DEFAULTS,strategyEnabledRanges:["Micro"],strategyTpSteps:[3],
    strategyIndicationTypes:["Tactic"],strategyIndicationSources:THIN_OSCILLATOR_SOURCE_IDS,
    strategyPriceDistancesEnabled:true,strategyShortStopPcts:[.2,.3],strategyTrailDistancePcts:[.05,.1,.15],
    strategyExitModes:["fixed","trailing-fixed"]})
  const configs = generateStrategyCatalog("oscillator-test",settings)
  assert.equal(configs.length,64)
  assert.equal(configurationCount(settings),configs.length)
  assert.equal(new Set(configs.map(config=>config.id)).size,configs.length)
  assert.deepEqual(new Set(configs.map(config=>config.stoploss)),new Set([.002,.003]))
  assert.deepEqual(new Set(configs.filter(config=>config.trailing).map(config=>config.trailDistancePct)),new Set([.05,.1,.15]))
})
