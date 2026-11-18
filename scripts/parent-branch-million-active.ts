/** Hosted, paper-only stress of one million current parent-owned stage Sets. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { generateStrategyCatalog } from "../core/catalog"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from "../core/engine"
import type { Candle, EngineState, LaneState } from "../core/types"

const TARGET = 1_000_000
const symbols = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, "0")}-USDT`)
const catalogBase = {
  strategyEnabledRanges: ["Micro"],
  strategyIndicationTypes: ["Trend"],
  strategyTpSteps: [3],
  strategySlRatios: [1],
  strategyExitModes: ["fixed"],
  strategySignalTimeframes: [1],
  strategyStageCoordinations: { main: ["normal"], real: ["normal"] },
  autoPfEnabled: true,
  autoPfRatio: .2,
}
const geometries = generateStrategyCatalog("terminal-million-active", catalogBase, "1970-01-01T00:00:00.000Z").length
const roots = geometries * symbols.length * 2
const width = Math.ceil(Math.cbrt(TARGET / roots))
const windows = Array.from({ length: width }, (_, i) => i + 1)
const catalog = { ...catalogBase, strategyLastNGrid: { base: windows, main: windows, real: windows } }
const settings = {
  symbols,
  connectionId: "terminal-million-active",
  stageGateMode: "parent-branches" as const,
  stageWindowScope: "context" as const,
  liveEntryMode: "real-mirror" as const,
  stageLastN: { base: 1, main: 1, real: 1 },
  stageMinPF: { base: 0, main: 0, real: 0 },
  catalog,
  initialEquity: 1_000,
  baseNotional: 1,
  volumeFactor: .001,
  coordinations: {
    axis: { ...DEFAULT_ENGINE_SETTINGS.coordinations.axis, enabled: false },
    block: { ...DEFAULT_ENGINE_SETTINGS.coordinations.block, enabled: false },
    dca: { ...DEFAULT_ENGINE_SETTINGS.coordinations.dca, enabled: false },
    relate: { ...DEFAULT_ENGINE_SETTINGS.coordinations.relate!, enabled: false },
  },
}
const bar = (index: number, symbolIndex: number): Candle => {
  const close = 100 + symbolIndex * .03 + 9 * Math.sin(index / 5) + 2 * Math.sin(index / 13)
  return { timestamp: 1_790_000_000_000 + index * 60_000, open: close, high: close, low: close, close, volume: 100 }
}
const batch = (from: number, count: number) => Object.fromEntries(symbols.map((symbol, i) =>
  [symbol, Array.from({ length: count }, (_, j) => bar(from + j, i))]))
const rss = () => {
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external }
}
const stageCounts = (engine: TradingEngine) => Object.fromEntries(engine.snapshot({ laneLimit: 0, positionLimit: 0 }).stages
  .map(stage => [stage.stage, { current: stage.currentLanes, qualified: stage.currentQualified, closed: stage.closed }]))
const totalCurrent = (counts: Record<string, { current: number }>) => Object.values(counts).reduce((n, row) => n + row.current, 0)
const digest = (lanes: Record<string, LaneState>) => {
  const hash = createHash("sha256")
  for (const id of Object.keys(lanes).sort()) {
    const lane = lanes[id]!
    hash.update(JSON.stringify([id, lane.stage, lane.coordination, lane.configId, lane.closedCount,
      lane.admissionCount, lane.parentProof?.at(-1)?.laneId ?? null]))
  }
  return hash.digest("hex")
}

mkdirSync("artifacts", { recursive: true })
const started = performance.now()
const baseline = rss()
let engine: TradingEngine | null = new TradingEngine(settings)
let index = 0
let counts = stageCounts(engine)
const checkpoints: Array<{ candles: number; current: number; memory: ReturnType<typeof rss>; stages: typeof counts }> = []
while (totalCurrent(counts) < TARGET && index < 1_800) {
  const size = 20
  engine.processMarketCandles(batch(index, size))
  index += size
  counts = stageCounts(engine)
  checkpoints.push({ candles: index * symbols.length, current: totalCurrent(counts), memory: rss(), stages: counts })
}
const materializedAt = performance.now()
const active = totalCurrent(counts)
const beforeRestart = rss()
let serialized = engine.serializeState()
const serializedBytes = Buffer.byteLength(serialized)
engine = null
global.gc?.()
const afterDrop = rss()
const inspection = (() => {
  const raw = JSON.parse(serialized) as EngineState
  const lanes = raw.lanes
  const laneIds = Object.keys(lanes)
  const byStage = { base: 0, main: 0, real: 0, live: 0 }
  const mainChildren = new Map<string, number>(), realChildren = new Map<string, number>()
  let missingParent = 0, duplicateIds = laneIds.length - new Set(laneIds).size
  for (const lane of Object.values(lanes)) {
    byStage[lane.stage]++
    const parent = lane.parentProof?.at(-1)?.laneId
    if (lane.stage !== "base" && (!parent || !lanes[parent])) missingParent++
    if (lane.stage === "main" && parent) mainChildren.set(parent, (mainChildren.get(parent) ?? 0) + 1)
    if (lane.stage === "real" && parent) realChildren.set(parent, (realChildren.get(parent) ?? 0) + 1)
  }
  let childCountFailures = 0
  for (const lane of Object.values(lanes)) {
    if (lane.stage === "base" && (mainChildren.get(lane.id) ?? 0) !== width) childCountFailures++
    if (lane.stage === "main" && (realChildren.get(lane.id) ?? 0) !== width) childCountFailures++
  }
  return { byStage, missingParent, duplicateIds, childCountFailures, beforeDigest: digest(lanes) }
})()
const { byStage, missingParent, duplicateIds, childCountFailures, beforeDigest } = inspection
global.gc?.()
const restoreStarted = performance.now()
const restored = TradingEngine.fromSerialized(serialized)
const restoredAt = performance.now()
serialized = ""
global.gc?.()
const afterDigest = digest((JSON.parse(restored.serializeState()) as EngineState).lanes)
global.gc?.()
const restoredCounts = stageCounts(restored)
const sustainedStarted = performance.now()
for (let chunk = 0; chunk < 3; chunk++) {
  restored.processMarketCandles(batch(index, 5))
  index += 5
}
const sustainedAt = performance.now()
const finalCounts = stageCounts(restored)
const pendingIntents = restored.pendingIntents().length
const summary = {
  target: TARGET, symbols: symbols.length, geometries, rootLanes: roots, windowWidth: width,
  expectedRealChildren: roots * width ** 3,
  processedCandlesBeforeRestart: checkpoints.at(-1)?.candles ?? 0,
  activeBeforeRestart: active, stagesBeforeRestart: counts, stageObjectCounts: byStage,
  serializedBytes, materializeSeconds: (materializedAt - started) / 1000,
  restoreSeconds: (restoredAt - restoreStarted) / 1000,
  sustainedCandles: 15 * symbols.length, sustainedSeconds: (sustainedAt - sustainedStarted) / 1000,
  activeAfterRestart: totalCurrent(restoredCounts), activeAfterLoad: totalCurrent(finalCounts),
  stagesAfterRestart: restoredCounts, stagesAfterLoad: finalCounts,
  baselineMemory: baseline, beforeRestartMemory: beforeRestart, afterDropMemory: afterDrop, finalMemory: rss(),
  digestBeforeRestart: beforeDigest, digestAfterRestart: afterDigest,
  duplicateIds, missingParent, childCountFailures, pendingIntents, checkpoints,
}
writeFileSync("artifacts/cts-c-million-active-parent-sets.json", JSON.stringify(summary, null, 2))
const escaped = JSON.stringify(summary, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
writeFileSync("artifacts/cts-c-million-active-parent-sets.html", `<!doctype html><meta charset="utf-8"><title>CTS-C million active parent Sets</title><style>body{font:14px system-ui;margin:32px;max-width:1100px}pre{white-space:pre-wrap;background:#111;color:#eee;padding:20px;border-radius:8px}</style><h1>CTS-C million active parent Sets</h1><p>Paper-only synthetic load. No exchange intents are permitted.</p><pre>${escaped}</pre>`)

assert.ok(active >= TARGET, `materialized ${active} current Sets, expected at least ${TARGET}`)
assert.equal(duplicateIds, 0)
assert.equal(missingParent, 0)
assert.equal(childCountFailures, 0)
assert.equal(beforeDigest, afterDigest)
assert.equal(totalCurrent(restoredCounts), active)
assert.equal(pendingIntents, 0)
console.log(JSON.stringify({ active, byStage, width, materializeSeconds: summary.materializeSeconds,
  restoreSeconds: summary.restoreSeconds, sustainedSeconds: summary.sustainedSeconds,
  rssMiB: summary.finalMemory.rss / 2 ** 20, heapMiB: summary.finalMemory.heapUsed / 2 ** 20,
  serializedMiB: serializedBytes / 2 ** 20, missingParent, childCountFailures, pendingIntents }))
