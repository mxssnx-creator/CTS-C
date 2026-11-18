import assert from "node:assert/strict"
import { test } from "node:test"
import { TradingEngine, DEFAULT_ENGINE_SETTINGS } from "../core/engine"
import type { Candle, EngineSettings, EngineEvent, LaneState } from "../core/types"

const symbol = "BTC-USDT"
const bars: Candle[] = Array.from({ length: 460 }, (_, i) => {
  const close = 100 + 9 * Math.sin(i / 5) + 2 * Math.sin(i / 13)
  return { timestamp: 1790000000000 + i * 60000, open: close, high: close, low: close, close, volume: 100 }
})
function settings(): Partial<EngineSettings> {
  return {
    symbols: [symbol], stageGateMode: "parent-branches", stageWindowScope: "context",
    stageLastN: { base: 2, main: 2, real: 2 }, stageMinPF: { base: 0, main: 0, real: 0 },
    catalog: { strategyEnabledRanges: ["Micro"], strategyIndicationTypes: ["Trend"], strategyTpSteps: [3],
      strategySlRatios: [1], strategyExitModes: ["fixed"], strategyLastNGrid: { base: [2, 3], main: [2, 4], real: [1, 3] },
      strategyStageCoordinations: { main: ["normal", "block"], real: ["normal", "dca"] } },
    coordinations: { axis: { ...DEFAULT_ENGINE_SETTINGS.coordinations.axis, enabled: false },
      block: DEFAULT_ENGINE_SETTINGS.coordinations.block, dca: DEFAULT_ENGINE_SETTINGS.coordinations.dca },
  }
}

test("each eligible parent forks all its own windows and coordinations, with an exact entry receipt", () => {
  const e = new TradingEngine(settings())
  const entries = new Map<string, { id: string; at: number; owner: string }>()
  const visit = (events: EngineEvent[]) => {
    const state = e.exportState()
    for (const event of events) {
      if (event.type !== "opened") continue
      const lane = state.lanes[event.laneId], position = lane.open!
      entries.set(position.id, { id: position.id, at: event.timestamp, owner: lane.id })
      if (lane.stage === "base") continue
      const parent = entries.get(position.parentPositionId!)
      assert.ok(parent, "each child order has a previously observed parent entry")
      assert.equal(parent.at, position.openedAt)
      assert.equal(parent.owner, lane.parentProof!.at(-1)!.laneId)
      if (lane.admissionCount === 1) assert.equal(lane.closedCount, 0)
    }
  }
  for (const bar of bars.slice(0, 220)) visit(e.processCandles(symbol, [bar]))
  const restored = TradingEngine.fromSerialized(e.serializeState())
  for (const bar of bars.slice(220)) {
    const original = e.processCandles(symbol, [bar])
    assert.deepEqual(restored.processCandles(symbol, [bar]), original)
    visit(original)
  }
  const state = e.exportState(), lanes = Object.values(state.lanes)
  assert.deepEqual(restored.exportState(), state)
  const base = lanes.filter(l => l.stage === "base"), main = lanes.filter(l => l.stage === "main"), real = lanes.filter(l => l.stage === "real")
  assert.equal(base.length, 2 * 3 * 2, "future choices do not duplicate Base history")
  const children = (parent: LaneState, rows: LaneState[]) => rows.filter(r => r.parentProof!.at(-1)!.laneId === parent.id)
  for (const p of base) assert.equal(children(p, main).length, 2 * 2)
  for (const p of main) assert.equal(children(p, real).length, 2 * 2)
  assert.ok(lanes.some(l => l.stage === "live" && l.closedCount > 0))
})

test("a million potential Last-N paths warm only Base until any parent qualifies", () => {
  const cfg = settings(), windows = Array.from({ length: 100 }, (_, i) => i + 1)
  cfg.catalog = { ...cfg.catalog, strategyLastNGrid: { base: windows, main: windows, real: windows } }
  cfg.stageMinPF = { base: 30, main: 30, real: 30 }
  const engine = new TradingEngine(cfg)
  let count = 0
  for (const bar of bars) {
    count += engine.processCandles(symbol, [bar]).length
    if (count) break
  }
  const lanes = Object.values(engine.exportState().lanes)
  assert.equal(lanes.length, 300)
  assert.ok(lanes.every(l => l.stage === "base" && l.closedCount === 0))
})

test("an Axis-only child keeps its same-stage Normal reference and resumes independently", () => {
  const cfg = settings()
  cfg.coordinations = {...cfg.coordinations!,axis:{enabled:true,previous:1,last:1,outcome:"any",reference:"same-stage"}}
  cfg.catalog = {...cfg.catalog,strategyLastNGrid:{base:[1],main:[1],real:[1]},strategyStageCoordinations:{main:["axis"],real:["axis"]}}
  const e = new TradingEngine(cfg)
  e.processMarketCandles({[symbol]:bars.slice(0,260)})
  const restored = TradingEngine.fromSerialized(e.serializeState())
  restored.processMarketCandles({[symbol]:bars.slice(260)})
  e.processMarketCandles({[symbol]:bars.slice(260)})
  assert.deepEqual(restored.exportState(), e.exportState())
  const lanes = Object.values(e.exportState().lanes)
  assert.ok(lanes.some(l=>l.stage==="real" && l.coordination==="normal" && l.calculationOnly && l.closedCount>0))
  assert.ok(lanes.some(l=>l.stage==="live" && l.coordination==="axis" && l.closedCount>0))
  assert.ok(lanes.filter(l=>l.stage==="live").every(l=>l.coordination==="axis"))
})

test("adding or removing future choices preserves parent IDs and never lends a sibling its proof", () => {
  const cfg=settings(),e=new TradingEngine(cfg)
  e.processMarketCandles({[symbol]:bars.slice(0,220)})
  const before=e.exportState(), baseIds=Object.values(before.lanes).filter(l=>l.stage==="base").map(l=>l.id)
  e.updateSettings({catalog:{...cfg.catalog,strategyLastNGrid:{base:[2,3],main:[2,4],real:[1,5]}}})
  e.processMarketCandles({[symbol]:bars.slice(220,350)})
  const rows=e.snapshot().lanes.filter(l=>l.current), current=e.exportState(), live=rows.filter(l=>l.stage==="live")
  assert.ok(live.some(l=>current.lanes[l.id].config.stageLastN!.real===5 && !before.lanes[l.id]))
  assert.ok(live.every(l=>current.lanes[l.id].config.stageLastN!.real!==3))
  assert.deepEqual(rows.filter(l=>l.stage==="base").map(l=>l.id),baseIds)
  const target=Object.values(current.lanes).find(l=>l.stage==="real" && l.config.stageLastN!.real===5 && l.parentProof)!
  const own=target.parentProof!.at(-1)!, other=Object.values(current.lanes).find(l=>l.stage==="main"&&l.id!==own.laneId)!
  own.laneId=other.id
  const restored=new TradingEngine(current.settings,current)
  assert.equal(restored.snapshot().lanes.find(l=>l.id===target.id)?.admissionReady,false)
})
