import {test} from 'node:test';import assert from 'node:assert/strict';import {portedStates,entryOnsets} from '../shared/cts-indications/index.ts';import {waveBars} from '../shared/cts-indications/fixtures.ts';import {advanceConfiguredSignal,newSignalState} from '../core/replay.ts';import {generateStrategyCatalog} from '../core/catalog.ts';import {DEFAULTS,configurationCount,validateConfiguration,hydrate} from '../core/settings-schema.ts';
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
 const cfg={...DEFAULTS,strategyIndicationTypes:['Tactic','Inverse'],strategyIndicationSources:['inverse-known-ema-9-21','tactic-dca-sweep-20-percent-0.5-2-0.25'],strategySignalTimeframes:[1,5,15,30],strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed']};
 const v=validateConfiguration(cfg);assert.deepEqual(hydrate(Object.fromEntries(Object.entries(v).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]))),v);
 const configs=generateStrategyCatalog('test',v);assert.equal(configs.length,7);assert.equal(configurationCount(v),7);assert.equal(new Set(configs.map(c=>c.id)).size,7);assert.ok(configs.every(c=>c.indicationSourceId));assert.ok(configs.filter(c=>c.type==='Inverse').every(c=>c.signalTimeframeMinutes!==30));
});

test("Low-Range ports each source and supported timeframe into its own Low-Range Set", () => {
 const ids = ["low-range-6-edge-turn-standalone", "low-range-6-breakout-activity"]
 const settings = validateConfiguration({
  ...DEFAULTS, strategyIndicationTypes: ["Low-Range"], strategyLowRangeSources: ids,
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
