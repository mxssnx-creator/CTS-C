import assert from "node:assert/strict"
import {test} from "node:test"
import {TradingEngine,DEFAULT_ENGINE_SETTINGS,validateEngineSettings} from "../core/engine"
import {generateStrategyCatalog} from "../core/catalog"
import {strategyProcessing} from "../core/strategy-processing"
import {DEFAULTS,validateConfiguration,hydrate,configurationCount} from "../core/settings-schema"
import type {Candle} from "../core/types"

const catalog={strategyTpSteps:[3,10],strategySlRatios:[1],strategyExitModes:["fixed","trailing","trailing-only"],strategyIndicationTypes:["MA_Cross"]}
const bars:Candle[]=Array.from({length:600},(_,i)=>{const p=100+10*Math.sin(i/5)+2*Math.sin(i/13);return {timestamp:1790000000000+i*60000,open:p,close:p,high:p,low:p,volume:100}})
test("global and independent range switches survive settings validation, hydration and catalog generation",()=>{
  for(const normal of [false,true])for(const trailing of [false,true]){
    const values={...DEFAULTS,...catalog,strategyNormalEnabled:normal,strategyTrailingEnabled:trailing,strategyProcessingByRange:{Micro:{normal:false,trailing:false},Short:{normal:true,trailing:true}}}
    assert.deepEqual(validateConfiguration(values),values)
    const hydrated=hydrate(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])))
    assert.deepEqual(hydrated,values)
    assert.deepEqual(strategyProcessing(values,{range:'Micro'}),{normal:false,trailing:false})
    assert.deepEqual(strategyProcessing(values,{range:'Short'}),{normal,trailing})
    const configs=generateStrategyCatalog('x02',values)
    assert.equal(configs.length,configurationCount(values))
    assert.ok(configs.filter(c=>c.range==='Micro').every(c=>c.exitMode==='fixed'))
    assert.equal(configs.filter(c=>c.range==='Short').length,trailing?3:1)
  }
  for(const value of [{Micro:{normal:'false'}},{Unknown:{normal:false}},[]])assert.throws(()=>validateConfiguration({strategyProcessingByRange:value},{partial:true}))
})
test("Normal off still calculates parents and progresses all enabled additional strategies through Live",()=>{
  const cfg=validateEngineSettings({...DEFAULT_ENGINE_SETTINGS,symbols:['BTC-USDT'],stageLastN:{base:2,main:2,real:2},stageMinPF:{base:0,main:0,real:0},catalog:{...catalog,strategyNormalEnabled:false,strategyTrailingEnabled:false}})
  const e=new TradingEngine(cfg);e.processCandles('BTC-USDT',bars,{allowExecution:true})
  const state=e.exportState(),lanes=Object.values(state.lanes)
  assert.ok(lanes.some(l=>l.coordination==='normal'&&l.stage==='real'&&l.closedCount>0),'Normal reference is still calculated')
  assert.ok(lanes.filter(l=>l.coordination==='normal'&&l.stage==='live').every(l=>l.calculationOnly))
  assert.ok(!e.snapshot().positions.some(p=>p.coordination==='normal'&&p.stage==='live'))
  assert.ok(e.snapshot().intents.every(i=>state.lanes[i.laneId].coordination!=='normal'))
  for(const coordination of ['axis','block','dca'])assert.ok(lanes.some(l=>l.coordination===coordination&&l.stage==='live'&&l.closedCount>0),coordination)
  assert.ok(state.intents.length>0)
  assert.ok(state.intents.every(i=>i.exitMode==='fixed'))
  const restored=TradingEngine.fromSerialized(e.serializeState())
  assert.deepEqual(restored.settings.catalog,cfg.catalog)
})
test("a range disable leaves another range's exact calculated closes unchanged",()=>{
  const cfg=validateEngineSettings({...DEFAULT_ENGINE_SETTINGS,symbols:['BTC-USDT'],stageLastN:{base:2,main:2,real:2},stageMinPF:{base:0,main:0,real:0},catalog})
  const a=new TradingEngine(cfg),b=new TradingEngine({...cfg,catalog:{...catalog,strategyProcessingByRange:{Micro:{normal:false,trailing:false}}}})
  a.processCandles('BTC-USDT',bars);b.processCandles('BTC-USDT',bars)
  const own=(e:TradingEngine)=>Object.values(e.exportState().lanes).filter(l=>l.config.range==='Short')
  assert.deepEqual(own(b),own(a))
})

test('Trailing off freezes a held stop without inventing a take-profit or loosening existing protection',async()=>{
 const {observedExit}=await import('../core/exits.ts');
 for(const direction of ['long','short']as const){const sign=direction==='long'?1:-1,base={direction,entryPrice:100,peak:100+sign*8,price:100+sign*10,takeProfitPct:3,stopLossPct:2,exitMode:'trailing-only' as const,openedAt:1,timestamp:60001,maxHoldMinutes:0,trailingActive:true,trailingStopPrice:100+sign*5,trailingEnabled:false};
  const frozen=observedExit(base);assert.equal(frozen.stop,base.trailingStopPrice);assert.equal(frozen.peak,base.peak);assert.equal(frozen.reason,undefined);
  assert.equal(observedExit({...base,price:base.trailingStopPrice-sign*.01}).reason,'trailing_stop');
 }
});
