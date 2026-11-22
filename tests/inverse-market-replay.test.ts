import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from "../core/engine"
import { generateStrategyCatalog } from "../core/catalog"
import { advancePortedSources, historicalPortedSignals, marketReferenceBars, newSignalState } from "../core/replay"
import { validateConfiguration } from "../core/settings-schema"
import { entryOnsets, portedStates } from "../shared/cts-indications"
import { alignedSourceStates } from "../shared/cts-indications/aligned"
import { waveBars } from "../shared/cts-indications/fixtures"
import type { Candle, ClosedTrade } from "../core/types"

const first="AAVE-USDT", anchor="ETH-USDT"
const relative=["inverse-pair-eth-spread-10","inverse-market-residual-10"]
const settings={...DEFAULT_ENGINE_SETTINGS,symbols:[first,anchor],catalog:{
  strategyIndicationTypes:["Inverse"],strategyIndicationSources:relative,strategyTpSteps:[5],strategySlRatios:[.8],strategyExitModes:["fixed"],
},coordinations:{...DEFAULT_ENGINE_SETTINGS.coordinations,axis:{...DEFAULT_ENGINE_SETTINGS.coordinations.axis,enabled:false},
  block:{...DEFAULT_ENGINE_SETTINGS.coordinations.block,enabled:false},dca:{...DEFAULT_ENGINE_SETTINGS.coordinations.dca,enabled:false}}}

function tape(n:number) {
  const peer=waveBars(n).map(bar=>({...bar,timestamp:bar.timestamp+60_000}))
  const own=peer.map((bar,i)=>{
    const close=bar.close+.8*Math.sin(i/2.1)
    const open=bar.open+.8*Math.sin((i-1)/2.1)
    return {...bar,close,open,high:Math.max(open,close)+.1,low:Math.min(open,close)-.1}
  })
  return {own,peer}
}

test("Inverse continuation uses the same inverted state and separate entries and settings",()=>{
  const known="inverse-known-ema-9-21",follow="inverse-follow-ema-9-21"
  const {own}=tape(640), raw=own.map(bar=>({...bar,timestamp:bar.timestamp-60_000}))
  const states=portedStates(first,1,raw,[known,follow]).states
  assert.deepEqual(states[known],states[follow])
  const observed=historicalPortedSignals(newSignalState(),own,1,[known,follow],first)
  const aligned=alignedSourceStates(first,raw,[known,follow].map(id=>({name:id,id,tf:1}))).states
  const streamed=newSignalState()
  let repeated=0
  for(const [i,bar] of own.entries()){
    const tick=advancePortedSources(streamed,bar,1,[known,follow],{symbol:first})
    assert.deepEqual(observed.get(bar.timestamp),tick)
    for(const id of [known,follow])assert.equal(aligned[id][i],tick.get(id)==="long"?1:tick.get(id)==="short"?-1:0)
    if (states[known][i]&&states[known][i]===states[known][i-1]){
      assert.equal(tick.get(known),undefined)
      assert.equal(tick.get(follow),states[known][i]>0?"long":"short")
      repeated++
    }
  }
  assert.ok(repeated>0)
  const catalog={...settings.catalog,strategyIndicationSources:[known,follow],strategySignalTimeframes:[1,5,15,30]}
  assert.doesNotThrow(()=>validateConfiguration(catalog,{partial:true}))
  const geometries=generateStrategyCatalog("test",catalog)
  assert.equal(geometries.length,6)
  assert.equal(new Set(geometries.map(config=>config.id)).size,6)
})

test("direct Activity sources are selectable and preserve their closed prefix",()=>{
  const ids=["act-burst-1.5","act-burst","act-burst-2.5","act-hf","act-hf-5","act-hf-8",
    "act-shift","act-chop","move-impulse-4-1.2","move-impulse"]
  const catalog={...settings.catalog,strategyIndicationTypes:["Tactic"],strategyIndicationSources:ids,strategySignalTimeframes:[1,5,15]}
  assert.doesNotThrow(()=>validateConfiguration(catalog,{partial:true}))
  const configs=generateStrategyCatalog("test",catalog)
  assert.equal(configs.length,ids.length*3)
  assert.equal(new Set(configs.map(config=>config.id)).size,configs.length)
  const {own}=tape(520)
  const raw=own.map((bar,i)=>({...bar,timestamp:bar.timestamp-60_000,high:bar.high+(i%43===0?1:0)}))
  const prefix=portedStates(first,1,raw.slice(0,320),ids),full=portedStates(first,1,raw,ids)
  for(const id of ids){
    assert.equal(full.available[id],true)
    assert.deepEqual(full.states[id].subarray(0,320),prefix.states[id])
  }
  assert.ok(prefix.states["act-burst"].some(Boolean))
  assert.ok(prefix.states["act-hf"].some(Boolean))
})

test("synchronized market replay gives the first symbol the reference at the same close and resumes exactly",()=>{
  const {own,peer}=tape(4800)
  const engine=new TradingEngine(settings), firstRun:ClosedTrade[]=[]
  engine.observeStageCloses(trade=>firstRun.push(trade))
  engine.processMarketCandles({[first]:own,[anchor]:peer})
  const expectedSource=generateStrategyCatalog("bingx-x02",settings.catalog).find(config=>config.indicationSourceId===relative[0])!.id
  assert.ok(firstRun.some(trade=>trade.symbol===first&&trade.configId===expectedSource),"the first symbol must use ETH available at the same decision close")
  assert.ok(firstRun.every(trade=>trade.symbol!==anchor||trade.configId!==expectedSource),"an anchor does not trade against itself")
  const prefix=new TradingEngine(settings), resumedTrades:ClosedTrade[]=[]
  const middle=4157
  prefix.observeStageCloses(trade=>resumedTrades.push(trade))
  prefix.processMarketCandles({[anchor]:peer.slice(0,middle),[first]:own.slice(0,middle)})
  const resumed=TradingEngine.fromSerialized(prefix.serializeState())
  resumed.observeStageCloses(trade=>resumedTrades.push(trade))
  resumed.processMarketCandles({[anchor]:peer.slice(middle-5),[first]:own.slice(middle-5)})
  assert.deepEqual(resumedTrades,firstRun)
  assert.deepEqual(resumed.snapshot(),engine.snapshot())
})

test("relative vectors use only native closes observable at the signal time",()=>{
  const {own,peer}=tape(1100)
  for(const minutes of [1,5]){
    const inputs=[relative[0],relative[1]]
    const observed=marketReferenceBars(undefined,peer,minutes)
    const full=historicalPortedSignals(newSignalState(),own,minutes,inputs,first,[{symbol:anchor,bars:observed}])
    const cutoff=own[676].timestamp
    const mutate=(bar:Candle)=>({...bar,open:bar.open*3,high:bar.high*3,low:bar.low*3,close:bar.close*3})
    const changes=observed.map(bar=>bar.timestamp+minutes*60_000>cutoff?mutate(bar):bar)
    const compare=historicalPortedSignals(newSignalState(),own,minutes,inputs,first,[{symbol:anchor,bars:changes}])
    for(const [at,values] of full)if(at<=cutoff)assert.deepEqual(compare.get(at),values)
    if(minutes===1){
      const raw=marketReferenceBars(undefined,own,1)
      const pair=portedStates(first,1,raw,[relative[0]],[{symbol:anchor,bars:observed}])
      const oracle=entryOnsets(pair.states[relative[0]])
      assert.ok(oracle.some(Boolean))
      for(const [i,bar] of own.entries())assert.equal(full.get(bar.timestamp)?.get(relative[0]),oracle[i]>0?"long":oracle[i]<0?"short":undefined)
    }
    const none=historicalPortedSignals(newSignalState(),own,minutes,inputs,first,[{symbol:anchor,bars:[]}])
    assert.ok([...none.values()].every(row=>[...row.values()].every(value=>value===undefined)))
  }
})
