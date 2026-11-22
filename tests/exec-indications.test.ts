import assert from "node:assert/strict"
import { test } from "node:test"
import { generateEngineCatalog } from "../core/catalog"
import { TradingEngine } from "../core/engine"
import { TerminalRuntime } from "../core/runtime"
import { StateStore } from "../core/store"
import type { Candle, ClosedTrade } from "../core/types"
import profile from "../research-data/exec-dca-trend-preset.json"

const symbol = "SOL-USDT"
const oscillators = ["rsi-mom-5-35", "rsi-mom-5-35-follow", "sar-fast", "sar-fast-follow"]
const expected = [...oscillators,"Trend","Break_Continuation"]

function observedTape(): Candle[] {
  let price=100
  return Array.from({length:2800},(_,index)=>{
    const side=Math.floor(index/39)%2===0 ? 1 : -1
    const leg=index%39
    const close=price*(1+side*(leg===10 ? -.012 : leg<13 ? .007 : .006))
    const bar={timestamp:1700000040000+60_000*index,open:price,high:Math.max(price,close),low:Math.min(price,close),close,volume:150}
    price=close
    return bar
  })
}

test("native RSI, SAR, Trend and Breakout signals produce qualified Exec entries after a cold warm-up and restart",async()=>{
  const store=new StateStore(":memory:")
  const runtime=new TerminalRuntime("bingx-x02",store)
  let resumed:TerminalRuntime|undefined
  try {
    runtime.saveFlatSettings({...profile,strategyIndicationTypes:["Tactic","Trend","Break_Continuation"],strategyIndicationSources:oscillators})
    runtime.engine.updateSettings({symbols:[symbol]})
    const bars=observedTape(), warmup=bars.slice(0,-500), holdout=bars.slice(-500)
    const batch = new TradingEngine(runtime.engine.settings)
    batch.processCandles(symbol,warmup,{eventLimit:0})
    await runtime.warmObservedHistory(symbol,warmup)
    assert.deepEqual(runtime.engine.snapshot(),batch.snapshot())
    assert.deepEqual(runtime.engine.pendingIntents(),[])
    runtime.shutdown()
    resumed=new TerminalRuntime("bingx-x02",store)
    const engine=resumed.engine
    const sources = new Map(generateEngineCatalog(engine.settings).map(config=>[config.id,config.indicationSourceId??config.type]))
    const identify = (configId:string) => sources.get(configId.split(".branch2.",1)[0])
    const closed = new Map<string,Readonly<ClosedTrade>>()
    engine.observeStageCloses(trade=>closed.set(trade.id,trade))
    for (const candle of holdout) engine.processCandles(symbol,[candle],{allowExecution:true,eventLimit:0})
    const intents=engine.pendingIntents().filter(intent=>intent.kind==="entry")
    assert.deepEqual(new Set(intents.map(intent=>identify(intent.configId))),new Set(expected))
    assert.equal(new Set(intents.map(intent=>intent.id)).size,intents.length)
    assert.ok(intents.every(intent=>intent.source==="exec-qualified"&&intent.execPositionId&&intent.qualificationId))
    const byExecPosition=new Map(intents.map(intent=>[intent.execPositionId,intent]))
    const trades = [...closed.values()].filter(trade=>trade.executed&&trade.openedAt>=holdout[0].timestamp)
    assert.deepEqual(new Set(trades.map(trade=>identify(trade.configId))),new Set(expected))
    for (const trade of trades) {
      const live=closed.get(byExecPosition.get(trade.id)?.positionId??"")!
      assert.ok(live,`Missing Live model exit for ${trade.id}`)
      assert.equal(live.parentPositionId,trade.id)
      assert.equal(live.netReturnPct,trade.netReturnPct)
      assert.equal(live.cost,trade.cost)
      assert.deepEqual(live.admission!.map(proof=>proof.stage),["base","main","real","exec"])
      assert.ok(live.admission!.every(proof=>proof.qualified&&proof.count===proof.required&&proof.checkedAt===live.openedAt))
    }
    assert.deepEqual(engine.processCandles(symbol,holdout,{allowExecution:true}),[])
    assert.equal(engine.pendingIntents().filter(intent=>intent.kind==="entry").length,intents.length)
  } finally { resumed?.shutdown();runtime.shutdown();store.close() }
})
