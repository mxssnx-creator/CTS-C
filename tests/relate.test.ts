import assert from "node:assert/strict"
import { test } from "node:test"
import { generateStrategyCatalog } from "../core/catalog"
import { TradingEngine, validateEngineSettings } from "../core/engine"
import { DEFAULT_RELATE, DEFAULT_RELATE_AUTO, relateAllocation, validateRelateAuto } from "../core/relate"
import type { Candle } from "../core/types"

const catalog = {
  strategyEnabledRanges: ["Short"], strategyTpSteps: [12], strategySlRatios: [.5, 1],
  strategyExitModes: ["fixed"], strategyIndicationTypes: ["Trend"],
}
const policy = { ...DEFAULT_RELATE, enabled: true, lastN: 60 }
const symbol = "BTC-USDT"

test("Relate sizes only qualified own returns within the configured stop and stack caps", () => {
  const [tight, wide] = generateStrategyCatalog("test", catalog)
  const sample = [...Array(3).fill(1), -.1, ...Array(56).fill(.2)]
  assert.equal(relateAllocation(sample, tight, policy), 1.6)
  assert.equal(relateAllocation(sample, wide, policy), 1)
  assert.equal(relateAllocation(sample.slice(0,59), tight, policy), 1)
  assert.equal(relateAllocation([-1, ...sample.slice(1)], tight, policy), 1)
  assert.equal(relateAllocation([1, NaN, ...sample.slice(2)], tight, policy), 1)
  assert.equal(relateAllocation(sample, {...tight, exitMode: "trailing-only-fixed"}, policy), 1)
  assert.equal(relateAllocation(sample, tight, {...policy, maxMultiplier: 1.2}), 1.2)
  assert.throws(() => validateEngineSettings({coordinations: {
    ...validateEngineSettings().coordinations, relate: {...policy, minTrades: 61},
  }}), /Relate minimum samples/)
})

test("Relate's Real allocation and exact Live mirror survive a checkpoint without borrowing another Set", () => {
  const bars = Array.from({length:480}, (_, i): Candle => {
    const close = 100 + 8 * Math.sin(i / 5) + Math.sin(i / 11)
    return { timestamp:1_790_000_000_000 + i * 60_000, open:close, high:close, low:close, close, volume:1 }
  })
  const defaults = validateEngineSettings()
  const engine = new TradingEngine({
    symbols: [symbol], stageGateMode: "processed-sets", catalog,
    stageLastN:{ base:1, main:1, real:1 }, stageMinPF:{ base:0, main:0, real:0 },
    coordinations: {
      ...defaults.coordinations,
      axis: {...defaults.coordinations.axis, enabled:false},
      block: {...defaults.coordinations.block, enabled:false},
      dca: {...defaults.coordinations.dca, enabled:false},
      relate: policy,
    },
  })
  engine.processCandles(symbol, bars.slice(0,250))
  const state = engine.exportState()
  const relationLanes = Object.values(state.lanes).filter(lane => lane.coordination === "relate" && lane.stage === "real")
  assert.ok(relationLanes.length >= 2)
  for (const lane of relationLanes) {
    lane.samples = Array.from({length:60}, () => 1)
    lane.sampleTimes = Array.from({length:60}, (_, i) => bars[249 - i].timestamp)
  }
  const resumed = TradingEngine.fromSerialized(JSON.stringify(state))
  const seen = new Map<number, number>()
  for (const bar of bars.slice(250)) {
    resumed.processCandles(symbol, [bar], {allowExecution: true})
    const snapshot = resumed.exportState()
    for (const lane of Object.values(snapshot.lanes)) {
      if (lane.coordination !== "relate" || lane.stage !== "live" || lane.open?.openedAt !== bar.timestamp) continue
      const position = lane.open
      const parent = Object.values(snapshot.lanes).find(row => row.open?.id === position.parentPositionId)!
      assert.equal(parent.configId, lane.configId)
      assert.deepEqual(parent.open!.fills, position.fills)
      const intent = resumed.pendingIntents().find(item => item.positionId === position.id && item.kind === "entry")
      assert.equal(intent?.entryAllocationRatio, position.notional / position.sizing!.baseBudget)
      const ratio = lane.config.slRatio!
      if (ratio === 1 || position.notional > position.sizing!.baseBudget) seen.set(ratio, intent!.entryAllocationRatio!)
    }
    if (seen.size === 2) break
  }
  assert.equal(seen.get(.5), 2)
  assert.equal(seen.get(1), 1)
})
test("Relate increases volume only when its own recent PF clears the disjoint Auto PF floor", () => {
  const settings = {...DEFAULT_RELATE,enabled:true,lastN:60,minTrades:60}
  const config = {...generateStrategyCatalog("test",{strategyTpSteps:[3],strategySlRatios:[.5],strategyExitModes:["fixed"]})[0],
    autoPfPolicy:{fallback:1.1,minSamples:16,history:40,adjustment:.75,cap:2}}
  const recent = [...Array<number>(33).fill(1),...Array<number>(27).fill(-1)]
  const weak = [...recent,...Array<number>(16).fill(-1)]
  assert.ok(relateAllocation(recent,config,settings,recent.length)>1)
  assert.equal(relateAllocation(weak,config,settings,weak.length),1)
  assert.ok(relateAllocation(weak,config,settings,weak.length-1)>1,"untimed older returns leave the fallback in force")
})

const auto = {...DEFAULT_RELATE_AUTO, enabled:true}
const autoPolicy = {...DEFAULT_RELATE, enabled:true, maxMultiplier:4, auto}
const [tightConfig, wideConfig] = generateStrategyCatalog("test", catalog)

test("Relate Auto raises volume with every consecutive win once a few returns prove the relation", () => {
  assert.equal(relateAllocation([1,1,1,-.2,1,1,1,1], tightConfig, autoPolicy), 1 + 3 * DEFAULT_RELATE.ratio)
  assert.equal(relateAllocation([1,1,1,1,1,1,1,1], tightConfig, autoPolicy), 1 + 8 * DEFAULT_RELATE.ratio, "each further win adds another step")
  assert.equal(relateAllocation([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], tightConfig, autoPolicy), 1 + DEFAULT_RELATE.steps * DEFAULT_RELATE.ratio, "the winning-step count caps the run")
  assert.equal(relateAllocation(Array(30).fill(1), tightConfig, {...autoPolicy, maxMultiplier:2}), 2, "the maximum multiplier caps the volume")
  assert.equal(relateAllocation([-1,1,1,1,1,1,1,1], tightConfig, autoPolicy), 1, "a loss returns the relation to base volume")
})

test("Relate Auto holds base volume without enough, weak, noisy or untrusted evidence", () => {
  assert.equal(relateAllocation([1,1,1,1,1,1,1], tightConfig, autoPolicy), 1, "below the minimum returns")
  assert.equal(relateAllocation([.1,-.1,.1,-.1,.1,-.1,.1,-.1], tightConfig, autoPolicy), 1, "PF below the floor")
  const noisy = [3,-2,3,-2,3,-2,3,-1.5]
  assert.equal(relateAllocation(noisy, tightConfig, autoPolicy), 1, "a positive mean inside its own standard error")
  assert.equal(relateAllocation(noisy, tightConfig, {...autoPolicy, auto:{...auto, confidence:0}}), 1 + DEFAULT_RELATE.ratio, "confidence 0 leaves only the PF floor")
  assert.equal(relateAllocation([1,NaN,1,1,1,1,1,1], tightConfig, autoPolicy), 1, "unknown returns never raise volume")
  assert.equal(relateAllocation(Array(30).fill(1), wideConfig, {...autoPolicy, auto:undefined}), 1, "manual sizing keeps the stop-to-target cap")
  assert.equal(relateAllocation(Array(30).fill(1), wideConfig, {...autoPolicy, maxMultiplier:2}), 2, "Auto sizes every relation, including stops the manual cap can never admit")
  assert.equal(relateAllocation(Array(30).fill(1), {...tightConfig, exitMode:"trailing-only"}, autoPolicy), 1, "trailing-only has no fixed target")
  assert.equal(relateAllocation(Array(30).fill(1), tightConfig, {...autoPolicy, enabled:false}), 1)
})

test("Relate Auto extends a short own tape only with older ancestor returns and respects the Auto PF floor", () => {
  const inherited = [1,1,1,1,-.5,1,1]
  assert.equal(relateAllocation([1,1,1], tightConfig, autoPolicy), 1, "three own returns are too few")
  assert.equal(relateAllocation([1,1,1], tightConfig, autoPolicy, 3, inherited), 1 + 7 * DEFAULT_RELATE.ratio)
  assert.equal(relateAllocation([1,1,1], tightConfig, {...autoPolicy, auto:{...auto, inherit:false}}, 3, inherited), 1, "inheritance can be switched off")
  const config = {...tightConfig, autoPfPolicy:{fallback:1.1,minSamples:16,history:40,adjustment:.75,cap:2}}
  const recent = [1.3,-1,1.3,-1,1.3,-1], older = Array.from({length:20}, (_, i) => i % 2 ? .5 : -1)
  const six = {...autoPolicy, auto:{...auto, lastN:6, minSamples:6, confidence:0}}
  assert.equal(relateAllocation(recent, config, six, 6), 1 + DEFAULT_RELATE.ratio, "the fallback floor 1.1 admits PF 1.3")
  assert.equal(relateAllocation(recent, config, six, 6, older), 1, "weak older history lifts the floor to 1.55")
})

test("Relate Auto settings are validated like the other Auto policies", () => {
  assert.deepEqual(validateRelateAuto(auto), auto)
  for (const bad of [{...auto, minSamples:2}, {...auto, minSamples:31, lastN:30}, {...auto, minPF:1}, {...auto, confidence:-1}, {...auto, confidence:3.1}, {...auto, inherit:"yes" as unknown as boolean}]) {
    assert.throws(() => validateRelateAuto(bad), /Relate Auto|Relate/)
  }
  const defaults = validateEngineSettings()
  const engine = validateEngineSettings({coordinations:{...defaults.coordinations, relate:{...DEFAULT_RELATE, enabled:true, auto}}})
  assert.equal(engine.coordinations.relate!.auto!.minSamples, DEFAULT_RELATE_AUTO.minSamples)
  assert.throws(() => validateEngineSettings({coordinations:{...defaults.coordinations, relate:{...DEFAULT_RELATE, enabled:true, auto:{...auto, lastN:2}}}}), /Relate/)
})

test("Relate Auto sizes the real entry from eight returns and the Live mirror matches it", () => {
  const bars = Array.from({length:480}, (_, i): Candle => {
    const close = 100 + 8 * Math.sin(i / 5) + Math.sin(i / 11)
    return { timestamp:1_790_000_000_000 + i * 60_000, open:close, high:close, low:close, close, volume:1 }
  })
  const defaults = validateEngineSettings()
  const engine = new TradingEngine({
    symbols: [symbol], stageGateMode: "processed-sets", catalog,
    stageLastN:{ base:1, main:1, real:1 }, stageMinPF:{ base:0, main:0, real:0 },
    coordinations: {
      ...defaults.coordinations,
      axis: {...defaults.coordinations.axis, enabled:false},
      block: {...defaults.coordinations.block, enabled:false},
      dca: {...defaults.coordinations.dca, enabled:false},
      relate: {...DEFAULT_RELATE, enabled:true, auto},
    },
  })
  engine.processCandles(symbol, bars.slice(0,250))
  const state = engine.exportState()
  const relationLanes = Object.values(state.lanes).filter(lane => lane.coordination === "relate" && lane.stage === "real")
  assert.ok(relationLanes.length >= 2)
  for (const lane of relationLanes) {
    lane.samples = Array.from({length:8}, () => 1)
    lane.sampleTimes = Array.from({length:8}, (_, i) => bars[249 - i].timestamp)
  }
  const resumed = TradingEngine.fromSerialized(JSON.stringify(state))
  const seen = new Map<number, number>()
  for (const bar of bars.slice(250)) {
    resumed.processCandles(symbol, [bar], {allowExecution: true})
    const snapshot = resumed.exportState()
    for (const lane of Object.values(snapshot.lanes)) {
      if (lane.coordination !== "relate" || lane.stage !== "live" || lane.open?.openedAt !== bar.timestamp) continue
      const position = lane.open
      const intent = resumed.pendingIntents().find(item => item.positionId === position.id && item.kind === "entry")
      assert.equal(intent?.entryAllocationRatio, position.notional / position.sizing!.baseBudget)
      const ratio = lane.config.slRatio!
      if (ratio === 1 || position.notional > position.sizing!.baseBudget) seen.set(ratio, intent!.entryAllocationRatio!)
    }
    if (seen.size === 2) break
  }
  assert.equal(seen.get(.5), 2, "eight winning returns reach the maximum multiplier without the 60-return gate")
  assert.equal(seen.get(1), 2, "a wide stop is a relation too: Auto sizes it from its own returns")
})

test("with a real edge Relate Auto compounds volume across relations while entries and return PF stay identical", () => {
  let seed = 7
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  let price = 100
  const bars = Array.from({length:3000}, (_, i): Candle => {
    price *= 1 + .0004 + .0007 * (random() - .5) * 2
    return { timestamp:1_790_000_000_000 + i * 60_000, open:price, high:price, low:price, close:price, volume:1 }
  })
  const run = (relate: typeof policy) => {
    const defaults = validateEngineSettings()
    const engine = new TradingEngine({
      symbols: [symbol], stageGateMode: "processed-sets", catalog,
      stageLastN:{ base:1, main:1, real:1 }, stageMinPF:{ base:0, main:0, real:0 },
      coordinations: { ...defaults.coordinations, axis:{...defaults.coordinations.axis, enabled:false}, block:{...defaults.coordinations.block, enabled:false}, dca:{...defaults.coordinations.dca, enabled:false}, relate },
    })
    const rows: Record<string, {n:number; returns:number; net:number; upsized:number}> = {}
    const smallest: Record<string, number> = {}
    engine.observeStageCloses(trade => {
      if (trade.stage !== "real") return
      const key = `${trade.coordination}/${trade.configId.includes("_sl5_") ? "tight" : "wide"}`
      const row = rows[key] ??= {n:0, returns:0, net:0, upsized:0}
      row.n++; row.returns += trade.netReturnPct; row.net += trade.netPnl
      smallest[key] = Math.min(smallest[key] ?? Infinity, trade.notional)
      if (trade.notional > smallest[key] * 1.0001) row.upsized++
    })
    engine.processCandles(symbol, bars, {eventLimit:0})
    return rows
  }
  const manual = run({...DEFAULT_RELATE, enabled:true, lastN:60, minTrades:60})
  const fast = run({...DEFAULT_RELATE, enabled:true, auto})
  const wide = run({...DEFAULT_RELATE, enabled:true, ratio:.4, maxMultiplier:4, auto})
  const normal = fast["normal/tight"], relation = fast["relate/tight"]
  assert.ok(normal.n >= 60, "the trend produces enough winners to size up")
  assert.equal(relation.n, normal.n, "Relate trades the same entries as Normal")
  assert.ok(Math.abs(relation.returns - normal.returns) < 1e-9, "per-position returns, hence return PF, are unchanged")
  assert.equal(normal.upsized, 0)
  assert.ok(relation.upsized > manual["relate/tight"].upsized, "Auto sizes up far sooner than the 60-return gate")
  assert.ok(relation.net > manual["relate/tight"].net && manual["relate/tight"].net > normal.net, "more qualified relations earn more")
  assert.ok(relation.net > normal.net * 1.5, "volume rising with each win nearly doubles profit under the 2x cap")
  assert.ok(wide["relate/tight"].net > relation.net * 1.5, "a higher step and cap compound further")
  assert.equal(manual["relate/wide"].upsized, 0, "manual sizing never admits a stop above half the target")
  assert.ok(Math.abs(manual["relate/wide"].net - manual["normal/wide"].net) < 1e-12)
  assert.ok(fast["relate/wide"].upsized > 0 && fast["relate/wide"].net > fast["normal/wide"].net, "Auto also sizes the wide-stop relation")
})

test("inherited Relate evidence is the ancestor's older stream: never overlapping the child's own closes, never a sibling's", () => {
  let seed = 11
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  let price = 100
  const bars = Array.from({length:2400}, (_, i): Candle => {
    price *= 1 + .0004 + .0007 * (random() - .5) * 2
    return { timestamp:1_790_000_000_000 + i * 60_000, open:price, high:price, low:price, close:price, volume:1 }
  })
  const defaults = validateEngineSettings()
  const engine = new TradingEngine({
    symbols: [symbol], stageGateMode: "exec-branches",
    catalog: {...catalog, strategyExecWindows:{
      base:{long:[10], short:[4], last:[1]}, main:{long:["none"], short:[4], last:[1]},
      real:{long:["none"], short:[4], last:[1]}, exec:{long:["none"], short:[4], last:[1]},
    }},
    coordinations: { ...defaults.coordinations, axis:{...defaults.coordinations.axis, enabled:false}, block:{...defaults.coordinations.block, enabled:false},
      dca:{...defaults.coordinations.dca, enabled:false}, relate:{...DEFAULT_RELATE, enabled:true, auto} },
  })
  const lanes = (engine as any).state.lanes as Record<string, any>
  const original = (engine as any).relateInherited.bind(engine) as (lane: any, before: number, limit: number) => number[] | undefined
  const calls: { fromAncestor: boolean; before: boolean; disjoint: boolean; values: boolean; count: number }[] = []
  ;(engine as any).relateInherited = (lane: any, before: number, limit: number) => {
    const result = original(lane, before, limit)
    const chain = lane.parentProof as { laneId: string }[] | undefined
    if (!result || !chain?.length) return result
    const ancestors = chain.map(proof => lanes[proof.laneId])
    const horizon = Math.min(before, lane.admittedAt ?? before)
    // Re-derive which ancestor closes could have been used, nearest ancestor first.
    const used: { time: number; value: number; owner: any }[] = []
    let bound = horizon
    for (let i = ancestors.length - 1; i >= 0 && used.length < result.length; i--) {
      const ancestor = ancestors[i]
      for (let k = 0; k < (ancestor.sampleTimes?.length ?? 0) && used.length < result.length; k++) {
        if (ancestor.sampleTimes[k] < bound) used.push({ time: ancestor.sampleTimes[k], value: ancestor.samples[k], owner: ancestor })
      }
      if (ancestor.admittedAt !== undefined) bound = Math.min(bound, ancestor.admittedAt)
    }
    const own: number[] = lane.sampleTimes ?? []
    calls.push({
      fromAncestor: used.every(item => ancestors.includes(item.owner) && item.owner.symbol === lane.symbol && item.owner.direction === lane.direction),
      before: used.every(item => item.time < horizon),
      disjoint: own.length === 0 || used.every(item => item.time < Math.min(...own)),
      values: used.length === result.length && used.every((item, index) => item.value === result[index]),
      count: result.length,
    })
    return result
  }
  engine.processCandles(symbol, bars, {eventLimit:0})
  const inheriting = calls.filter(call => call.count > 0)
  assert.ok(calls.length > 0 && inheriting.length > 0, "Relate sizes from inherited evidence while its own tape is short")
  for (const call of calls) {
    assert.ok(call.fromAncestor, "returns come only from this Set's own ancestors on the same symbol and side")
    assert.ok(call.before, "only closes before the descendant's first entry")
    assert.ok(call.disjoint, "never overlapping the child's own closes")
    assert.ok(call.values, "the values are exactly the ancestor's returns, newest first")
  }
  assert.equal(original({parentProof: undefined, admittedAt: 1}, 5, 10), undefined, "a Base-stage Set has nothing to inherit")
})
