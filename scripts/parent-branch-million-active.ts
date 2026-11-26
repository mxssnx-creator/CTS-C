/** Hosted, paper-only stress of one million current parent-owned stage Sets. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { deflateRawSync } from "node:zlib"
import { generateStrategyCatalog } from "../core/catalog"
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from "../core/engine"
import { StateStore } from "../core/store"
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
let proofState:EngineState|null = engine.exportState()
let proofReferences=0,recursiveProofPrefixes=0,sharedRecursiveProofPrefixes=0
const uniqueProofObjects=new Set<object>()
for(const lane of Object.values(proofState.lanes)){
  const chain=lane.parentProof??[]
  for(const proof of chain){proofReferences++;uniqueProofObjects.add(proof)}
  if(chain.length<2)continue
  const parent=proofState.lanes[chain.at(-1)!.laneId]
  for(let i=0;i<chain.length-1;i++){
    recursiveProofPrefixes++
    if(chain[i]===parent?.parentProof?.[i])sharedRecursiveProofPrefixes++
  }
}
const lineageStorage={proofReferences,uniqueProofObjects:uniqueProofObjects.size,recursiveProofPrefixes,sharedRecursiveProofPrefixes}
proofState=null
global.gc?.()
const beforeRestart = rss()
let serialized = engine.serializeState()
const fullSerializedBytes = Buffer.byteLength(serialized)
const compactStore = new StateStore(":memory:")
const compactSaveStarted = performance.now()
compactStore.migrateLaneCheckpoint(engine.checkpointPayload(), engine.checkpointLanes(true), [], engine.settings, () => {})
const compactSaveAt = performance.now()
const compactRecord = compactStore.database.prepare("SELECT SUM(length(data)) AS bytes FROM records WHERE key IN ('engine','engine-configs-v5')").get() as { bytes:number }
const compactRows = compactStore.database.prepare("SELECT COALESCE(SUM(length(id)+length(data)),0) AS bytes FROM engine_lanes").get() as { bytes:number }
const compactCheckpointBytes = compactRecord.bytes + compactRows.bytes
const laneIdBytes=(compactStore.database.prepare("SELECT COALESCE(SUM(length(id)),0) AS bytes FROM engine_lanes").get() as {bytes:number}).bytes
const laneStorageLayout=(()=>{
  const rowid=new DatabaseSync(":memory:"),bounded=new DatabaseSync(":memory:"),normalized=new DatabaseSync(":memory:")
  rowid.exec("CREATE TABLE engine_lanes(id TEXT PRIMARY KEY,data TEXT NOT NULL); BEGIN")
  bounded.exec("CREATE TABLE engine_lanes(id TEXT PRIMARY KEY,data TEXT NOT NULL) WITHOUT ROWID; BEGIN")
  normalized.exec(`CREATE TABLE engine_lane_ids(id TEXT PRIMARY KEY,ref INTEGER NOT NULL UNIQUE) WITHOUT ROWID;
    CREATE TABLE engine_lanes(ref INTEGER PRIMARY KEY,data TEXT NOT NULL); BEGIN`)
  const rowidInsert=rowid.prepare("INSERT INTO engine_lanes VALUES(?,?)")
  const boundedInsert=bounded.prepare("INSERT INTO engine_lanes VALUES(?,?)")
  const normalizedIdInsert=normalized.prepare("INSERT INTO engine_lane_ids VALUES(?,?)")
  const normalizedDataInsert=normalized.prepare("INSERT INTO engine_lanes VALUES(?,?)")
  let ref=0
  for(const lane of compactStore.database.prepare("SELECT id,data FROM engine_lanes ORDER BY id").iterate() as Iterable<{id:string;data:Uint8Array}>){
    rowidInsert.run(lane.id,lane.data);boundedInsert.run(lane.id,lane.data)
    normalizedIdInsert.run(lane.id,++ref);normalizedDataInsert.run(ref,lane.data)
  }
  rowid.exec("COMMIT");bounded.exec("COMMIT");normalized.exec("COMMIT")
  const liveBytes=(database:DatabaseSync)=>{
    const page=(database.prepare("PRAGMA page_count").get() as {page_count:number}).page_count
    const free=(database.prepare("PRAGMA freelist_count").get() as {freelist_count:number}).freelist_count
    const size=(database.prepare("PRAGMA page_size").get() as {page_size:number}).page_size
    return (page-free)*size
  }
  const rowidBytes=liveBytes(rowid),withoutRowidBytes=liveBytes(bounded),normalizedBytes=liveBytes(normalized)
  const rowidIndexes=(rowid.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND tbl_name='engine_lanes'").get() as {count:number}).count
  const withoutRowidIndexes=(bounded.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND tbl_name='engine_lanes'").get() as {count:number}).count
  const normalizedIndexes=(normalized.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND tbl_name IN ('engine_lane_ids','engine_lanes')").get() as {count:number}).count
  rowid.close();bounded.close();normalized.close()
  return {laneIdBytes,rowidBytes,withoutRowidBytes,normalizedBytes,
    withoutRowidDeltaBytes:rowidBytes-withoutRowidBytes,
    normalizedSavingsBytes:rowidBytes-normalizedBytes,
    normalizedSavingsRatio:(rowidBytes-normalizedBytes)/rowidBytes,
    rowidIndexes,withoutRowidIndexes,normalizedIndexes}
})()
engine = null
global.gc?.()
const afterDrop = rss()
const inspection = (() => {
  const raw = JSON.parse(serialized) as EngineState
  const lanes = raw.lanes
  const {lanes:_lanes,...state}=raw
  const v2Configs:Record<string,LaneState["config"]>={}
  let v2RowsBytes=0,v3RowsBytes=0
  const laneIds = Object.keys(lanes)
  const byStage = { base: 0, main: 0, real: 0, exec: 0, live: 0 }
  const mainChildren = new Map<string, number>(), realChildren = new Map<string, number>()
  let missingParent = 0, duplicateIds = laneIds.length - new Set(laneIds).size
  for (const lane of Object.values(lanes)) {
    byStage[lane.stage]++
    v2Configs[lane.configId]??=lane.config
    const {id,config,...v2Mutable}=lane
    const {configId,...mutable}=v2Mutable
    const v2Encoded="z1:"+deflateRawSync(Buffer.from(JSON.stringify(v2Mutable)),{level:1}).toString("base64")
    const v3Encoded="z1:"+deflateRawSync(Buffer.from(JSON.stringify({...mutable,c:configId})),{level:1}).toString("base64")
    v2RowsBytes+=Buffer.byteLength(id)+Buffer.byteLength(v2Encoded)
    v3RowsBytes+=Buffer.byteLength(id)+Buffer.byteLength(v3Encoded)
    const parent = lane.parentProof?.at(-1)?.laneId
    if (lane.stage !== "base" && (!parent || !lanes[parent])) missingParent++
    if (lane.stage === "main" && parent) mainChildren.set(parent, (mainChildren.get(parent) ?? 0) + 1)
    if (lane.stage === "real" && parent) realChildren.set(parent, (realChildren.get(parent) ?? 0) + 1)
  }
  let childCountFailures = 0
  for (const count of mainChildren.values()) if (count !== width) childCountFailures++
  for (const count of realChildren.values()) if (count !== width) childCountFailures++
  const v2MetadataBytes=Buffer.byteLength(JSON.stringify({checkpointFormat:"lane-rows-v2",payload:{state,configs:v2Configs}}))
  const v3MetadataBytes=Buffer.byteLength(JSON.stringify({checkpointFormat:"lane-rows-v3",payload:{laneRowsVersion:3,state,configs:v2Configs}}))
  return { byStage, missingParent, duplicateIds, childCountFailures, beforeDigest: digest(lanes),
    v2CheckpointBytes:v2MetadataBytes+v2RowsBytes,v3CheckpointBytes:v3MetadataBytes+v3RowsBytes }
})()
const { byStage, missingParent, duplicateIds, childCountFailures, beforeDigest, v2CheckpointBytes, v3CheckpointBytes } = inspection
global.gc?.()
const clearIndex=(value:unknown)=>(value as {clear():void}).clear()
const profileDerivedIndex=(name:string,drop:(engine:Record<string,unknown>)=>void)=>{
  global.gc?.()
  let probe:TradingEngine|null=TradingEngine.fromSerialized(serialized)
  global.gc?.()
  const loaded=rss()
  drop(probe as unknown as Record<string,unknown>)
  global.gc?.()
  const afterDrop=rss()
  probe=null
  global.gc?.()
  return {name,loadedHeapBytes:loaded.heapUsed,afterDropHeapBytes:afterDrop.heapUsed,
    releasedHeapBytes:Math.max(0,loaded.heapUsed-afterDrop.heapUsed)}
}
const derivedIndexProfiles=[
  profileDerivedIndex("contexts",engine=>clearIndex(engine.contexts)),
  profileDerivedIndex("validLineages",engine=>clearIndex(engine.validLineages)),
  profileDerivedIndex("childrenByLane",engine=>clearIndex(engine.childrenByLane)),
  profileDerivedIndex("activeSets",engine=>{clearIndex(engine.active);clearIndex(engine.activeMicro);clearIndex(engine.activeMinute);clearIndex(engine.livePositions)}),
  profileDerivedIndex("parentIndexes",engine=>{clearIndex(engine.contexts);clearIndex(engine.validLineages);clearIndex(engine.childrenByLane)}),
]
const restoreStarted = performance.now()
const restoredState = compactStore.loadEngineState()
assert.ok(restoredState)
const restored = TradingEngine.fromOwnedCheckpoint(restoredState)
const retainedCurrentLaneIndex="currentLaneIds" in (restored as unknown as Record<string,unknown>)
const restoredAt = performance.now()
compactStore.close()
serialized = ""
global.gc?.()
const afterDigest = digest(restoredState.lanes)
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
const targetMet = active >= TARGET
const activeHeapDelta = Math.max(0, beforeRestart.heapUsed - baseline.heapUsed)
const activeRssDelta = Math.max(0, beforeRestart.rss - baseline.rss)
const summary = {
  target: TARGET, targetMet, symbols: symbols.length, geometries, rootLanes: roots, windowWidth: width,
  expectedRealChildren: roots * width ** 3,
  processedCandlesBeforeRestart: checkpoints.at(-1)?.candles ?? 0,
  activeBeforeRestart: active, stagesBeforeRestart: counts, stageObjectCounts: byStage,
  fullSerializedBytes, v2CheckpointBytes, v3CheckpointBytes, compactCheckpointBytes, compactRatio: compactCheckpointBytes / fullSerializedBytes,
  configRefSavingsBytes:v2CheckpointBytes-v3CheckpointBytes,
  configRefSavingsRatio:(v2CheckpointBytes-v3CheckpointBytes)/v2CheckpointBytes,
  laneRowSavingsBytes:v3CheckpointBytes-compactCheckpointBytes,
  laneRowSavingsRatio:(v3CheckpointBytes-compactCheckpointBytes)/v3CheckpointBytes,
  materializeSeconds: (materializedAt - started) / 1000,
  compactSaveSeconds: (compactSaveAt - compactSaveStarted) / 1000,
  restoreSeconds: (restoredAt - restoreStarted) / 1000,
  sustainedCandles: 15 * symbols.length, sustainedSeconds: (sustainedAt - sustainedStarted) / 1000,
  activeAfterRestart: totalCurrent(restoredCounts), activeAfterLoad: totalCurrent(finalCounts),
  stagesAfterRestart: restoredCounts, stagesAfterLoad: finalCounts,
  baselineMemory: baseline, beforeRestartMemory: beforeRestart, afterDropMemory: afterDrop, finalMemory: rss(),
  projectedMillion: {
    activeHeapDeltaBytes: active ? Math.round(activeHeapDelta * TARGET / active) : null,
    activeRssDeltaBytes: active ? Math.round(activeRssDelta * TARGET / active) : null,
    fullSerializedBytes: active ? Math.round(fullSerializedBytes * TARGET / active) : null,
    v2CheckpointBytes: active ? Math.round(v2CheckpointBytes * TARGET / active) : null,
    v3CheckpointBytes: active ? Math.round(v3CheckpointBytes * TARGET / active) : null,
    compactCheckpointBytes: active ? Math.round(compactCheckpointBytes * TARGET / active) : null,
  },
  digestBeforeRestart: beforeDigest, digestAfterRestart: afterDigest, lineageStorage, laneStorageLayout, derivedIndexProfiles, retainedCurrentLaneIndex,
  duplicateIds, missingParent, childCountFailures, pendingIntents, checkpoints,
}
writeFileSync("artifacts/cts-c-million-active-parent-sets.json", JSON.stringify(summary, null, 2))
const escaped = JSON.stringify(summary, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
writeFileSync("artifacts/cts-c-million-active-parent-sets.html", `<!doctype html><meta charset="utf-8"><title>CTS-C million active parent Sets</title><style>body{font:14px system-ui;margin:32px;max-width:1100px}pre{white-space:pre-wrap;background:#111;color:#eee;padding:20px;border-radius:8px}</style><h1>CTS-C million active parent Sets</h1><p>Paper-only capacity characterization toward one million current parent-owned Sets. No exchange intents are permitted.</p><pre>${escaped}</pre>`)

assert.ok(active >= 20_000, `materialized only ${active} current Sets; capacity characterization did not reach its minimum load`)
assert.equal(duplicateIds, 0)
assert.equal(missingParent, 0)
assert.equal(childCountFailures, 0)
assert.ok(lineageStorage.recursiveProofPrefixes>0)
assert.equal(lineageStorage.sharedRecursiveProofPrefixes,lineageStorage.recursiveProofPrefixes)
assert.ok(lineageStorage.uniqueProofObjects<lineageStorage.proofReferences)
assert.ok(compactCheckpointBytes < fullSerializedBytes * .8, `compact checkpoint ratio was ${compactCheckpointBytes/fullSerializedBytes}`)
assert.ok(compactCheckpointBytes<v2CheckpointBytes, `bounded checkpoint ${compactCheckpointBytes} did not improve v2 ${v2CheckpointBytes}`)
assert.ok(compactCheckpointBytes<v3CheckpointBytes, `compact lane rows ${compactCheckpointBytes} did not improve v3 ${v3CheckpointBytes}`)
assert.ok(laneStorageLayout.withoutRowidBytes>laneStorageLayout.rowidBytes,
  `rejected WITHOUT ROWID prototype unexpectedly improved rowid table`)
assert.ok(laneStorageLayout.normalizedBytes>=laneStorageLayout.rowidBytes,
  `current rowid lane table regressed past normalized exact storage`)
assert.equal(laneStorageLayout.rowidIndexes,1)
assert.equal(laneStorageLayout.withoutRowidIndexes,0)
assert.equal(beforeDigest, afterDigest)
assert.equal(retainedCurrentLaneIndex,false)
assert.equal(totalCurrent(restoredCounts), active)
assert.equal(pendingIntents, 0)
console.log(JSON.stringify({ active, targetMet, byStage, width, materializeSeconds: summary.materializeSeconds,
  compactSaveSeconds: summary.compactSaveSeconds, restoreSeconds: summary.restoreSeconds, sustainedSeconds: summary.sustainedSeconds,
  rssMiB: summary.finalMemory.rss / 2 ** 20, heapMiB: summary.finalMemory.heapUsed / 2 ** 20,
  fullSerializedMiB: fullSerializedBytes / 2 ** 20, v2CheckpointMiB:v2CheckpointBytes / 2 ** 20,
  v3CheckpointMiB:v3CheckpointBytes / 2 ** 20, compactCheckpointMiB: compactCheckpointBytes / 2 ** 20, compactRatio: summary.compactRatio,
  configRefSavingsBytes:summary.configRefSavingsBytes, configRefSavingsRatio:summary.configRefSavingsRatio,
  laneRowSavingsBytes:summary.laneRowSavingsBytes,laneRowSavingsRatio:summary.laneRowSavingsRatio,lineageStorage, laneStorageLayout, derivedIndexProfiles, retainedCurrentLaneIndex, missingParent, childCountFailures, pendingIntents }))
