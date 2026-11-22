import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Candle, EngineSettings } from "../core/types"

async function main() {
  const [mode="catalog", source="."] = process.argv.slice(2)
  if (mode!=="catalog"&&mode!=="profile") throw new Error("Use catalog or profile workload")
  const {TradingEngine,DEFAULT_ENGINE_SETTINGS} = await import(pathToFileURL(resolve(source,"core/engine.ts")).href) as typeof import("../core/engine")
  const gc = global.gc
  if (!gc) throw new Error("Run this performance test with --expose-gc")
  const active = mode === "profile"
  const symbols=Array.from({length:active?50:500},(_,i)=>`PERF${i+1}-USDT`)
  const catalog = active ? {...DEFAULT_ENGINE_SETTINGS.catalog,strategyTrendDcaEnabled:true,strategySarDcaEnabled:true,
    strategyEnabledRanges:["Minimal"],strategyIndicationTypes:["MA_Cross"],strategyTpSteps:[6],strategySlRatios:[1],strategyExitModes:["fixed"]}
    : {...DEFAULT_ENGINE_SETTINGS.catalog,strategyTrendDcaEnabled:false}
  const build=(sign:number): Candle[] => {
    let close=100
    return Array.from({length:active?400:200},(_,i)=>{
      if(active)close*=1+sign*(i%7===5?-.0035:.010)
      return {timestamp:1790000040000+i*60_000,open:close,high:close,low:close,close,volume:100}
    })
  }
  const up=build(1), down=active?build(-1):up
  gc()
  const heapStart=process.memoryUsage().heapUsed
  const start=performance.now()
  const engine=new TradingEngine({symbols,catalog,stageGateMode:"exec-branches"} satisfies Partial<EngineSettings>)
  const initMs=performance.now()-start
  gc()
  const catalogMiB=(process.memoryUsage().heapUsed-heapStart)/2**20
  const began=performance.now()
  for (const [i,symbol] of symbols.entries()) engine.processCandles(symbol,i%2===0?up:down,{eventLimit:0})
  const processMs=performance.now()-began
  gc()
  const heapMiB=(process.memoryUsage().heapUsed-heapStart)/2**20
  const snapshot=engine.snapshot({laneLimit:0,positionLimit:0})
  const exec=snapshot.stages.find(s=>s.stage==="exec")!
  const live=snapshot.stages.find(s=>s.stage==="live")!
  assert.equal(snapshot.processedCandles,symbols.length*up.length)
  assert.equal(exec.executed!.closed,live.closed)
  assert.equal(exec.executed!.open,live.open)
  assert.equal(snapshot.intents.length,0)
  if(active) {
    assert.equal(snapshot.catalogCount,4)
    assert.ok(exec.executed!.closed>1000)
    assert.ok(live.longOpen>0&&live.shortOpen>0)
    assert.ok(heapMiB<200,`Active profile retained ${heapMiB.toFixed(1)} MiB`)
  } else {
    assert.equal(snapshot.catalogCount,252)
    assert.equal(exec.executed!.closed,0)
    if(source===".")assert.ok(catalogMiB<8,`Shared catalog retained ${catalogMiB.toFixed(1)} MiB`)
  }
  assert.ok(processMs<15_000,`${mode} candle dispatch took ${processMs.toFixed(1)} ms`)
  console.log(JSON.stringify({mode,symbols:symbols.length,geometries:snapshot.catalogCount,bars:snapshot.processedCandles,
    initMs,processMs,catalogMiB,heapMiB,sets:snapshot.stages.map(s=>s.lanes),executed:exec.executed!.closed}))
}

void main()
