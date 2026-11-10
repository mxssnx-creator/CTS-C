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
    runtime.engine.activePositionIds = () => new Set(["position-a"])
    for (const kind of ["entry", "add"] as const) assert.doesNotThrow(() => validate(intent(kind)))
    runtime.pause()
    for (const kind of ["entry", "add"] as const) assert.throws(() => validate(intent(kind)), /no longer active/)
    runtime.control.exchangeExecution = true
    runtime.engine.activePositionIds = () => new Set()
    for (const kind of ["entry", "add"] as const) assert.throws(() => validate(intent(kind)), /no longer active/)
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
