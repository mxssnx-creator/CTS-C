import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TerminalRuntime } from "../core/runtime"
import { TradingEngine } from "../core/engine"
import { getStore } from "../core/store"
import type { ExecutionIntent } from "../core/types"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Quote tick waited for the background executor")), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function intent(kind: ExecutionIntent["kind"]): ExecutionIntent {
  return { id: `intent-${kind}`, connectionId: "bingx-x02", laneId: "lane-a", configId: "config-a", symbol: "BTC-USDT", direction: "long", kind,
    positionId: "position-a", requestedQuantity: 1, timestamp: Date.now(), price: 100, notional: 100, takeProfitPct: 2, stopLossPct: 1, exitMode: "fixed", source: "real-qualified", status: "pending" }
}
async function isolated(work: (runtime: TerminalRuntime) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "ctsc-runtime-loop-"))
  const priorDirectory = process.env.CTS_DATA_DIR
  const priorFetch = globalThis.fetch
  process.env.CTS_DATA_DIR = directory
  globalThis.fetch = async () => { throw new Error("Network access is forbidden in runtime-loop tests") }
  const runtime = new TerminalRuntime(), internal = runtime as any
  try {
    internal.ensureLease()
    runtime.control.running = true
    runtime.control.exchangeExecution = true
    runtime.control.warmed = [...runtime.engine.settings.symbols]
    getStore().set("account", { equity: 1000, updatedAt: Date.now() })
    let count = 0
    internal.client = {
      quotes: async () => runtime.engine.settings.symbols.map((symbol) => ({ symbol, price: 100 + (++count) / 1000, timestamp: Date.now() })),
      balance: async () => ({ equity: 1000 }),
      candles: async () => { throw new Error("Already-warmed symbols should not fetch history") },
    }
    await work(runtime)
  } finally {
    runtime.shutdown()
    getStore().close()
    globalThis.fetch = priorFetch
    if (priorDirectory === undefined) delete process.env.CTS_DATA_DIR
    else process.env.CTS_DATA_DIR = priorDirectory
    rmSync(directory, { recursive: true, force: true })
  }
}

test("quote ticks finish and continue while one background execution promise is blocked", async () => {
  await isolated(async (runtime) => {
    const internal = runtime as any
    const blocked = deferred<any[]>()
    let executorCalls = 0, observedQuotes = 0
    const originalTick = runtime.engine.processTick.bind(runtime.engine)
    runtime.engine.processTick = (...args) => { observedQuotes++; return originalTick(...args) }
    internal.executor = { process: () => { executorCalls++; return executorCalls === 1 ? blocked.promise : Promise.resolve([]) } }
    await within(internal.tick())
    const firstTask = internal.executionTask
    assert.ok(firstTask, "background execution should remain in flight")
    const firstQuotes = observedQuotes
    await within(internal.tick())
    assert.ok(observedQuotes > firstQuotes, "active quote management must continue")
    assert.equal(executorCalls, 1, "a pending executor must not get a concurrent process call")
    assert.equal(internal.executionTask, firstTask)
    blocked.resolve([])
    await firstTask
    assert.equal(internal.executionTask, undefined)
    await within(internal.tick())
    assert.equal(executorCalls, 2, "execution resumes after the previous cycle finishes")
    await internal.executionTask
  })
})

test("runtime write callbacks recheck paused and closed paper positions for entries and additions", async () => {
  await isolated(async (runtime) => {
    const internal = runtime as any
    const validate = internal.executor.options.validateIntent as (intent: ExecutionIntent) => void
    runtime.engine.isLiveIntentEligible = id => id==='position-a'
    for (const kind of ["entry", "add"] as const) assert.doesNotThrow(() => validate(intent(kind)))
    runtime.pause()
    for (const kind of ["entry", "add"] as const) assert.throws(() => validate(intent(kind)), /no longer active/)
    runtime.control.exchangeExecution = true
    runtime.engine.isLiveIntentEligible = () => false
    for (const kind of ["entry", "add"] as const) assert.throws(() => validate(intent(kind)), /no longer active/)
  })
})

test('offline observed warmup checkpoints each symbol, resumes duplicates and preserves lost-lease fencing',async()=>{
  await isolated(async runtime=>{
    const internal=runtime as any,symbol=runtime.engine.settings.symbols[0]
    const end=Math.floor(Date.now()/60000)*60000-60000
    const bars=Array.from({length:48},(_,i)=>{const close=100+Math.sin(i/3);return {timestamp:end-(47-i)*60000,open:close,high:close,low:close,close,volume:1}})
    await assert.rejects(runtime.warmObservedHistory(symbol,bars),/stopped runtime/)
    runtime.control.running=false;runtime.control.exchangeExecution=false
    await runtime.warmObservedHistory(symbol,bars)
    const saved=runtime.store.loadEngineState()!
    assert.equal(saved.lastTimestamp[symbol],end);assert.equal(saved.intents.length,0)
    const count=saved.processedCandles;await runtime.warmObservedHistory(symbol,bars)
    assert.equal(runtime.store.loadEngineState()!.processedCandles,count)
    await assert.rejects(runtime.warmObservedHistory(symbol,[{...bars[0],timestamp:end+120000}]),/complete contiguous/)
    runtime.store.releaseLease(internal.owner)
    await assert.rejects(runtime.warmObservedHistory(symbol,bars),/lease expired/)
    assert.equal(runtime.store.loadEngineState()!.processedCandles,count)
  })
})

test("shutdown prevents a delayed executor callback from reacquiring ownership or overwriting state", async () => {
  await isolated(async (runtime) => {
    const internal = runtime as any, blocked = deferred<any[]>()
    const state = runtime.engine.exportState()
    state.intents = [intent("close")]
    runtime.engine = new TradingEngine(state.settings, state)
    internal.executor = { process: () => blocked.promise }
    await within(internal.tick())
    const background = internal.executionTask
    const oldOwner = internal.owner
    runtime.shutdown()
    assert.equal(getStore().ownsLease(oldOwner), false)
    assert.throws(() => internal.ensureLease(), /ownership was lost/)
    const replacement = new TerminalRuntime(), newInternal = replacement as any
    try {
      newInternal.ensureLease()
      assert.equal(getStore().ownsLease(newInternal.owner), true)
      blocked.resolve([{ id: "intent-close", status: "acknowledged", exchangeOrderId: "12345" }])
      await background
      assert.equal(getStore().ownsLease(oldOwner), false)
      assert.equal(getStore().ownsLease(newInternal.owner), true)
      assert.equal(getStore().get<any>("engine").intents[0].status, "pending", "late old-process callback must not overwrite authoritative engine state")
      assert.match(runtime.control.lastError || "", /ownership was lost/)
    } finally { replacement.shutdown() }
  })
})

for (const readyCount of [2, 3]) test(`one tick consumes ${readyCount} ready history jobs once with execution disabled and one batch checkpoint`, async () => {
  await isolated(async (runtime) => {
    const internal = runtime as any
    runtime.control.warmed = []
    internal.prefetchHistory = () => {}
    internal.executor = { process: async () => [] }
    const symbols = runtime.engine.settings.symbols.slice(0, readyCount)
    const timestamp = Math.floor(Date.now() / 60_000) * 60_000 - 60_000
    for (const symbol of symbols) internal.warmJobs.set(symbol, { data: [{ timestamp, open: 100, high: 100, low: 100, close: 100, volume: 1 }] })
    const calls: { symbol: string; allowExecution: boolean | undefined }[] = []
    const processCandles = runtime.engine.processCandles.bind(runtime.engine)
    runtime.engine.processCandles = (symbol, candles, options) => { calls.push({ symbol, allowExecution: options?.allowExecution }); return processCandles(symbol, candles, options) }
    const checkpoints: string[][] = [], persist = internal.persist.bind(runtime)
    internal.persist = (...args: unknown[]) => { checkpoints.push([...runtime.control.warmed]); return persist(...args) }
    await within(internal.tick())
    if (internal.executionTask) await internal.executionTask
    assert.deepEqual(calls, symbols.map(symbol => ({ symbol, allowExecution: false })))
    assert.deepEqual(runtime.control.warmed, symbols)
    assert.equal(internal.warmJobs.size, 0)
    assert.deepEqual(checkpoints, [[], symbols], "initial quote checkpoint plus exactly one history-batch checkpoint")
    assert.equal(runtime.engine.pendingIntents().length, 0)
    await within(internal.tick())
    if (internal.executionTask) await internal.executionTask
    assert.equal(calls.length, readyCount, "consumed history jobs must not be processed twice")
  })
})

test("history batch keeps failed-symbol retry separate and leaves unfinished jobs untouched", async () => {
  await isolated(async (runtime) => {
    const internal = runtime as any
    runtime.control.warmed = []
    internal.prefetchHistory = () => {}
    internal.executor = { process: async () => [] }
    const [failed, ready, pending] = runtime.engine.settings.symbols
    const timestamp = Math.floor(Date.now() / 60_000) * 60_000 - 60_000
    internal.warmJobs.set(failed, { error: "Historical data unavailable" })
    internal.warmJobs.set(ready, { data: [{ timestamp, open: 100, high: 100, low: 100, close: 100, volume: 1 }] })
    internal.warmJobs.set(pending, {})
    const before = Date.now()
    await within(internal.tick())
    if (internal.executionTask) await internal.executionTask
    assert.deepEqual(runtime.control.warmed, [ready])
    assert.ok(internal.warmRetryAt.get(failed) >= before + 30_000)
    assert.equal(internal.warmJobs.has(pending), true)
    assert.equal(internal.warmJobs.has(failed), false)
    assert.equal(internal.warmJobs.has(ready), false)
    assert.match(runtime.control.lastError || "", /Historical data unavailable/)
    assert.equal(runtime.engine.pendingIntents().length, 0)
  })
})

test("a quote gap pauses that symbol before a later bar or trade can be processed", async () => {
  await isolated(async runtime=>{
    const internal=runtime as any, symbol=runtime.engine.settings.symbols[0]
    internal.prefetchHistory=()=>{}
    internal.executor={process:async()=>[]}
    const bucket=Math.floor(Date.now()/60_000)*60_000
    internal.bars.set(symbol,{bucket:bucket-120_000,candle:{timestamp:bucket-120_000,open:100,high:100,low:100,close:100,volume:0},lastObservation:bucket-60_001})
    let seen=0
    const tick=runtime.engine.processTick.bind(runtime.engine)
    runtime.engine.processTick=(s,p,t)=>{if(s===symbol)seen++;return tick(s,p,t)}
    await within(internal.tick())
    if(internal.executionTask)await internal.executionTask
    assert.equal(runtime.control.warmed.includes(symbol),false)
    assert.equal(internal.bars.has(symbol),false)
    assert.equal(seen,0)
    assert.match(runtime.control.lastError??"",/market-data gap/)
  })
})

test("history catch-up does not mark a symbol warm before reaching the current closed minute", async () => {
  await isolated(async runtime=>{
    const internal=runtime as any, symbol=runtime.engine.settings.symbols[0]
    internal.prefetchHistory=()=>{}
    internal.executor={process:async()=>[]}
    runtime.control.warmed=[]
    const now=Math.floor(Date.now()/60_000)*60_000, start=now-180_000
    const candle=(timestamp:number)=>({timestamp,open:100,high:100,low:100,close:100,volume:1})
    runtime.engine.processCandles(symbol,[candle(start)])
    internal.warmJobs.set(symbol,{data:[candle(start+60_000)],plan:{count:100,cursor:start,cutoff:start+60_000}})
    await within(internal.tick());if(internal.executionTask)await internal.executionTask
    assert.equal(runtime.engine.lastProcessedAt(symbol),start+60_000)
    assert.equal(runtime.control.warmed.includes(symbol),false)
    internal.warmJobs.set(symbol,{data:[candle(start+120_000),candle(now)],plan:{count:100,cursor:start+60_000,cutoff:now}})
    await within(internal.tick());if(internal.executionTask)await internal.executionTask
    assert.equal(runtime.engine.lastProcessedAt(symbol),now)
    assert.equal(runtime.control.warmed.includes(symbol),true)
  })
})

test('fresh signal updates use exchange OHLCV and volume while warm-up remains non-executable',async()=>{
 await isolated(async runtime=>{
  const internal=runtime as any,symbol=runtime.engine.settings.symbols[0],now=Math.floor(Date.now()/60000)*60000
  internal.prefetchHistory=()=>{};internal.executor={process:async()=>[]}
  runtime.engine.processCandles(symbol,[{timestamp:now-60000,open:100,high:100,low:100,close:100,volume:5}])
  const native={timestamp:now,open:100,high:102,low:99,close:101,volume:1234}
  internal.warmJobs.set(symbol,{data:[native],plan:{cursor:now-60000,cutoff:now,count:100},live:true})
  const seen:any[]=[],original=runtime.engine.processCandles.bind(runtime.engine)
  runtime.engine.processCandles=(symbol,candles,options)=>{seen.push({symbol,candles,options});return original(symbol,candles,options)}
  await internal.tick();if(internal.executionTask)await internal.executionTask
  assert.deepEqual(seen,[{symbol,candles:[native],options:{allowExecution:true,eventLimit:5000}}]);assert.equal(runtime.engine.lastProcessedAt(symbol),now)
 })
})

test('history recovery yields between bounded slices and matches complete engine state and PF',async()=>{
 await isolated(async runtime=>{
  const internal=runtime as any,symbol=runtime.engine.settings.symbols[0],now=Math.floor(Date.now()/60000)*60000
  internal.prefetchHistory=()=>{};internal.executor={process:async()=>[]};runtime.control.warmed=[]
  runtime.engine=new TradingEngine({...runtime.engine.settings,symbols:[symbol],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
  const reference=new TradingEngine(runtime.engine.settings),candles=Array.from({length:512},(_,i)=>{const close=100+8*Math.sin(i/17);return {timestamp:now-(511-i)*60000,open:close,high:close,low:close,close,volume:1}})
  reference.processCandles(symbol,candles,{allowExecution:false})
  internal.warmJobs.set(symbol,{data:candles,plan:{count:512,cursor:null,cutoff:now}})
  const sizes:number[]=[],processCandles=runtime.engine.processCandles.bind(runtime.engine)
  runtime.engine.processCandles=(s,cs,options)=>{sizes.push(cs.length);return processCandles(s,cs,options)}
  let ticks=0
  while(!runtime.control.warmed.includes(symbol)&&ticks<100){await internal.tick();if(internal.executionTask)await internal.executionTask;ticks++}
  assert.ok(ticks>1&&ticks<100);assert.ok(sizes.every(n=>n<=8));assert.equal(sizes.reduce((a,b)=>a+b,0),512)
  assert.equal(runtime.control.running,true);assert.ok(getStore().ownsLease(internal.owner))
  const actual=runtime.engine.exportState(),expected=reference.exportState();actual.startedAt=expected.startedAt=0
  assert.deepEqual(actual,expected);assert.equal(runtime.engine.pendingIntents().length,0)
 })
})

test('a malformed late history candle is rejected before any earlier slice mutates the engine',async()=>{
 await isolated(async runtime=>{
  const internal=runtime as any,symbol=runtime.engine.settings.symbols[0],now=Math.floor(Date.now()/60000)*60000
  internal.prefetchHistory=()=>{};internal.executor={process:async()=>[]};runtime.control.warmed=[]
  const data=Array.from({length:200},(_,i)=>({timestamp:now-(199-i)*60000,open:100,high:100,low:100,close:100,volume:1}));data[199].high=99
  internal.warmJobs.set(symbol,{data,plan:{count:200,cursor:null,cutoff:now}})
  await internal.tick();if(internal.executionTask)await internal.executionTask
  assert.equal(runtime.engine.lastProcessedAt(symbol),null);assert.equal(runtime.engine.snapshot({laneLimit:0,positionLimit:0}).processedCandles,0)
  assert.match(runtime.control.lastError??'',/Invalid or unsorted/);assert.equal(runtime.control.warmed.includes(symbol),false)
 })
})


test("slow account reads cannot block quotes, duplicate refreshes, or history processing",async()=>{
 await isolated(async runtime=>{
  const internal=runtime as any,blocked=deferred<any>();let calls=0,quotes=0
  getStore().set('account',{equity:1000,updatedAt:0})
  internal.client.balance=()=>{calls++;return blocked.promise}
  internal.executor={process:async()=>[]}
  const tick=runtime.engine.processTick.bind(runtime.engine);runtime.engine.processTick=(...args)=>{quotes++;return tick(...args)}
  await within(internal.tick());const task=internal.accountTask;assert.ok(task)
  const seen=quotes;await within(internal.tick());assert.ok(quotes>seen);assert.equal(calls,1)
  blocked.resolve({equity:1234});await task;assert.equal(getStore().get<any>('account').equity,1234);assert.equal(internal.accountTask,undefined)
  getStore().set('account',{equity:1000,updatedAt:0});internal.client.balance=async()=>{calls++;throw Error('Temporary account read failure')}
  await within(internal.tick());await internal.accountTask;const failedCalls=calls
  await within(internal.tick());assert.equal(calls,failedCalls,'failed refresh observes its retry delay');assert.match(internal.accountError,/Account refresh/)
 })
})

test("a delayed account response cannot write after shutdown and replacement ownership",async()=>{
 await isolated(async runtime=>{
  const internal=runtime as any,blocked=deferred<any>()
  getStore().set('account',{equity:1000,updatedAt:0});internal.client.balance=()=>blocked.promise;internal.executor={process:async()=>[]}
  await within(internal.tick());const task=internal.accountTask;assert.ok(task);runtime.shutdown()
  const replacement=new TerminalRuntime(),next=replacement as any
  try{next.ensureLease();getStore().set('account',{equity:2222,updatedAt:123});blocked.resolve({equity:9999});await task;assert.equal(getStore().get<any>('account').equity,2222);assert.equal(getStore().ownsLease(next.owner),true)}
  finally{replacement.shutdown()}
 })
})


test('cold history advances during a blocked quote read while fresh live bars wait for that quote cycle',async()=>{
 await isolated(async runtime=>{
  const r=runtime as any,blocked=deferred<any[]>(),now=Math.floor(Date.now()/60000)*60000
  r.client.quotes=()=>blocked.promise;r.prefetchHistory=()=>{};r.executor={process:async()=>[]}
  runtime.engine=new TradingEngine({symbols:['BTC-USDT','ETH-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
  runtime.control.warmed=['ETH-USDT'];const bar=(timestamp:number)=>({timestamp,open:100,high:100,low:100,close:100,volume:1})
  runtime.engine.processCandles('ETH-USDT',[bar(now-60000)])
  const data=Array.from({length:512},(_,i)=>bar(now-(511-i)*60000))
  r.warmJobs.set('BTC-USDT',{data,plan:{count:512,cursor:null,cutoff:now},live:false})
  r.warmJobs.set('ETH-USDT',{data:[bar(now)],plan:{count:100,cursor:now-60000,cutoff:now},live:true})
  const task=r.tick();await new Promise(resolve=>setTimeout(resolve,80))
  assert.ok(runtime.engine.lastProcessedAt('BTC-USDT')!==null,'closed observed history must progress while quotes are pending')
  assert.equal(runtime.engine.lastProcessedAt('ETH-USDT'),now-60000,'a fresh executable bar waits for normal quote-cycle processing')
  assert.equal(runtime.engine.pendingIntents().length,0)
  blocked.resolve([{symbol:'ETH-USDT',price:100,timestamp:Date.now()}]);await within(task);await r.quoteTask;await within(r.tick());if(r.executionTask)await r.executionTask
  assert.equal(runtime.engine.lastProcessedAt('ETH-USDT'),now)
 })
})

test('cold recovery during delayed quotes matches a full observed pass without truncation or duplicate samples',async()=>{
 await isolated(async runtime=>{
  const r=runtime as any,blocked=deferred<any[]>(),now=Math.floor(Date.now()/60000)*60000
  r.client.quotes=()=>blocked.promise;r.prefetchHistory=()=>{};r.executor={process:async()=>[]};runtime.control.warmed=[]
  runtime.engine=new TradingEngine({symbols:['BTC-USDT'],stageGateMode:'processed-sets',stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
  const data=Array.from({length:256},(_,i)=>{const close=100+9*Math.sin(i/11);return {timestamp:now-(255-i)*60000,open:close,high:close,low:close,close,volume:1}}),reference=new TradingEngine(runtime.engine.settings)
  reference.processCandles('BTC-USDT',data);r.warmJobs.set('BTC-USDT',{data,plan:{count:256,cursor:null,cutoff:now},live:false})
  const task=r.tick();await within(task);for(let i=0;i<100&&runtime.engine.lastProcessedAt('BTC-USDT')!==now;i++)await within(r.tick())
  assert.equal(runtime.engine.lastProcessedAt('BTC-USDT'),now);assert.equal(runtime.control.warmed.includes('BTC-USDT'),true)
  blocked.resolve([]);await within(task);if(r.executionTask)await r.executionTask
  const actual=JSON.parse(runtime.engine.serializeState()),expected=JSON.parse(reference.serializeState());actual.startedAt=expected.startedAt=0;assert.deepEqual(actual,expected)
 })
})


test('eight live symbols progress during a pending quote cycle only against verified post-close marks',async()=>{
 await isolated(async runtime=>{
  const r=runtime as any,blocked=deferred<any[]>(),now=Math.floor(Date.now()/60000)*60000,symbols=Array.from({length:8},(_,i)=>`LIVE${i}-USDT`)
  r.client.quotes=()=>blocked.promise;r.prefetchHistory=()=>{};r.executor={process:async()=>[]};runtime.control.warmed=symbols
  runtime.engine=new TradingEngine({symbols,catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
  const make=(timestamp:number)=>({timestamp,open:100,high:100,low:100,close:100,volume:1}),calls:{symbol:string;executable:boolean|undefined}[]=[]
  for(const symbol of symbols){runtime.engine.processCandles(symbol,[make(now-60000)]);r.marks.set(symbol,{price:100,timestamp:Date.now()});r.warmJobs.set(symbol,{data:[make(now)],plan:{count:100,cursor:now-60000,cutoff:now},live:true})}
  const process=runtime.engine.processCandles.bind(runtime.engine);runtime.engine.processCandles=(s,b,o)=>{calls.push({symbol:s,executable:o?.allowExecution});return process(s,b,o)}
  const task=r.tick();for(let i=0;i<100&&calls.length<8;i++)await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(calls.length,8);assert.ok(calls.every(c=>c.executable===true));assert.ok(symbols.every(s=>runtime.engine.lastProcessedAt(s)===now))
  blocked.resolve([]);await within(task);if(r.executionTask)await r.executionTask;assert.equal(calls.length,8,'no duplicate processing after quote completion')
 })
})

test('a stale or pre-close quote cannot authorize a fresh executable history bar',async()=>{
 await isolated(async runtime=>{
  const r=runtime as any,now=Math.floor(Date.now()/60000)*60000,symbol='BTC-USDT';r.prefetchHistory=()=>{};r.client.quotes=async()=>[];r.executor={process:async()=>[]}
  runtime.engine=new TradingEngine({symbols:[symbol],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}});runtime.control.warmed=[symbol]
  const bar=(timestamp:number)=>({timestamp,open:100,high:100,low:100,close:100,volume:1});runtime.engine.processCandles(symbol,[bar(now-60000)])
  r.marks.set(symbol,{price:100,timestamp:now-60000});r.warmJobs.set(symbol,{data:[bar(now)],plan:{count:100,cursor:now-60000,cutoff:now},live:true})
  let allowed:boolean|undefined;const process=runtime.engine.processCandles.bind(runtime.engine);runtime.engine.processCandles=(s,b,o)=>{allowed=o?.allowExecution;return process(s,b,o)}
  await r.tick();if(r.executionTask)await r.executionTask;assert.equal(allowed,undefined);assert.equal(runtime.engine.lastProcessedAt(symbol),now-60000);assert.equal(runtime.engine.pendingIntents().length,0)
  r.marks.set(symbol,{price:100,timestamp:Date.now()});await r.tick();assert.equal(allowed,true);assert.equal(runtime.engine.lastProcessedAt(symbol),now)
 })
})


test("submitted instance-scoped entries retain reconciliation priority after the paper position closes",async()=>{
  await isolated(async runtime=>{
    const internal=runtime as any,entry={...intent('entry'),timestamp:Date.now()-60000},close=intent('close')
    const wireId=internal.executor.clientOrderId(entry.connectionId,entry.id)
    runtime.store.claimIntent(wireId,{intent:entry,order:{clientOrderId:wireId}})
    assert.equal(runtime.store.hasExecutionIntent(entry.connectionId,entry.id),true)
    assert.equal(runtime.store.hasExecutionIntent('bingx-x01',entry.id),false)
    const state=runtime.engine.exportState();state.intents=[entry,close]
    runtime.engine=new TradingEngine(state.settings,state)
    assert.equal(runtime.engine.activePositionIds().has(entry.positionId),false)
    let submitted:ExecutionIntent[]=[]
    internal.executor={process:async(ready:ExecutionIntent[])=>{submitted=ready;return []}}
    internal.pumpExecution()
    await internal.executionTask
    assert.deepEqual(submitted.map(i=>i.id),[entry.id],"unknown venue entry must reconcile before its own close")
    assert.equal(runtime.engine.pendingIntents().find(i=>i.id===entry.id)?.status,'pending')
  })
})

test("stream execution dispatches a close before the next main tick and coalesces in-flight work",async()=>{
  await isolated(async runtime=>{
    const internal=runtime as any, blocked=deferred<any[]>()
    const state=runtime.engine.exportState();state.intents=[intent("close")]
    runtime.engine=new TradingEngine(state.settings,state)
    let calls=0
    internal.executor={process:(ready:ExecutionIntent[])=>{calls++;assert.deepEqual(ready.map(i=>i.id),["intent-close"]);return blocked.promise}}
    internal.tradeStream={status:{generation:0},drain:()=>[],stop:()=>{}}
    internal.consumeTrades()
    assert.equal(calls,1,"100ms stream callback must dispatch without invoking tick()")
    const task=internal.executionTask
    for(let i=0;i<100;i++)internal.consumeTrades()
    assert.equal(calls,1,"slow venue creates no concurrent or queued executor promises")
    blocked.resolve([{id:"intent-close",status:"acknowledged"}]);await task
    internal.consumeTrades();assert.equal(calls,1,"idle stream does not poll the venue at 10Hz")
    assert.equal(runtime.engine.pendingIntents().length,0)
  })
})


test('explicit observed-study symbols survive native startup and invalid scopes cannot select replacement symbols',async()=>{
 await isolated(async runtime=>{
  const priorKey=process.env.BINGX_X02_KEY,priorSecret=process.env.BINGX_X02_SECRET;
  process.env.BINGX_X02_KEY='offline-fixture';process.env.BINGX_X02_SECRET='offline-fixture';
  try {
   const internal=runtime as any,chosen=['ZZZ-USDT','ALT-USDT'];let reads=0;
   const symbols=['BTC-USDT','ETH-USDT',...chosen];
   const client={balance:async()=>{reads++;return{equity:1000,available:1000}},contracts:async()=>symbols.map(symbol=>({symbol})),quotes:async()=>symbols.map(symbol=>({symbol,price:100,timestamp:Date.now()})),commission:async()=>({maker:.0002,taker:.0005})};
   internal.createClient=()=>client;internal.client=client;
   runtime.control.running=false;runtime.control.exchangeExecution=false;runtime.control.symbolCount=2;
   runtime.engine.updateSettings({symbols:chosen,catalog:{...runtime.engine.settings.catalog,microTradeStream:false}});
   const end=Math.floor(Date.now()/60000)*60000-60000;
   await runtime.warmObservedHistory(chosen[0],[{timestamp:end,open:100,high:100,low:100,close:100,volume:1}]);
   await runtime.start({symbols:chosen});
   assert.deepEqual(runtime.engine.settings.symbols,chosen);
   assert.equal(runtime.engine.lastProcessedAt(chosen[0]),end,'startup preserves the exact observed-history generation');
   runtime.stop();reads=0;
   await assert.rejects(runtime.start({symbols:[chosen[0],chosen[0]]}),/Explicit symbols/);
   assert.equal(reads,0,'duplicate scopes fail before account or market reads');
   await assert.rejects(runtime.start({symbols:['MISSING-USDT',chosen[0]]}),/metadata and quotes/);
   assert.deepEqual(runtime.engine.settings.symbols,chosen);
  }finally{
   if(priorKey===undefined)delete process.env.BINGX_X02_KEY;else process.env.BINGX_X02_KEY=priorKey;
   if(priorSecret===undefined)delete process.env.BINGX_X02_SECRET;else process.env.BINGX_X02_SECRET=priorSecret;
  }
 })
})
