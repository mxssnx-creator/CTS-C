/**
 * Independent audit of every stage's Last-N and min-PF / Auto-PF gate. Paper only: no exchange client is built.
 *
 * The evaluator below is deliberately naive (plain loops over newest-first returns, no prefix sums, no caches) so it
 * can disagree with the engine. It checks, per stage:
 *   A. every lane's published window result against a recomputation from the lane's own retained returns,
 *   B. every admission proof, verified at the moment its position opens from the live lane tapes (so nothing is
 *      pruned): stage order, window size, floor, Auto PF evidence, decision clock, lineage, and a numeric
 *      recomputation from the proof lane's returns strictly before the clock,
 *   C. sample independence: a Main/Real/Exec lane's returns are exactly its own closes, never borrowed from a sibling.
 *
 * Usage: node --import tsx scripts/audit-stage-gates.ts TAPE_DIR RESULT_JSON SCENARIO_JSON [symbol count] [lane stage|all]
 * The scenario format is the one used by replay-exec-stages.ts (tapeMinutes, warmupMinutes, settings). Passing a lane
 * stage limits check A to that stage, which keeps full-catalog scenarios affordable; B and C always cover everything.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TradingEngine, STAGES } from "../core/engine.ts"
import type { Candle, ClosedTrade, GateProof } from "../core/types.ts"

type Polarity = "positive" | "negative"
type Policy = { long: number; short: number; minimal: number; shortPolarity: Polarity; minimalPolarity: Polarity; lastRequiresPF?: boolean }
type AutoPolicy = { fallback: number; minSamples: number; history: number; adjustment: number; cap: number }
const GATED = ["base", "main", "real", "exec"] as const
const DEFAULT_EXEC_MIN_PF = 1.1

const [directory, output, scenarioFile, countText = "3", laneStage = "all"] = process.argv.slice(2)
if (!directory || !output || !scenarioFile) throw new Error("Usage: audit-stage-gates.ts TAPE_DIR RESULT_JSON SCENARIO_JSON [symbol count] [lane stage|all]")
const scenario = JSON.parse(readFileSync(scenarioFile, "utf8")) as { warmupMinutes: number; tapeMinutes: number; settings: any }
const symbolCount = Number(countText)

/* ---------- independent evaluator (newest first) ---------- */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
function blockState(samples: readonly number[], offset: number, n: number, minPf: number, polarity: Polarity, signOnly: boolean) {
  if (n === 0) return { state: "qualified" as const, gp: 0, gl: 0, net: 0, count: 0, edge: false }
  const slice = samples.slice(offset, offset + n)
  let gp = 0, gl = 0, net = 0
  for (const v of slice) { if (Number.isFinite(v)) { gp += Math.max(0, v); gl += Math.max(0, -v); net += v } }
  const count = slice.length
  if (slice.some(v => typeof v !== "number" || !Number.isFinite(v))) return { state: "unknown" as const, gp, gl, net, count, edge: false }
  if (count < n) return { state: "insufficient" as const, gp, gl, net, count, edge: false }
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0
  const passed = polarity === "negative" ? net < 0 : net > 0 && (signOnly || pf >= minPf)
  // A decision within rounding of a threshold is reported as an edge case, not as a disagreement.
  const edge = Math.abs(net) < 1e-9 || (Number.isFinite(pf) && Math.abs(pf - minPf) < 1e-9)
  return { state: passed ? ("qualified" as const) : ("failed" as const), gp, gl, net, count, edge }
}
function evaluate(samples: readonly number[], p: Policy, minPf: number) {
  const minimal = blockState(samples, 0, p.minimal, minPf, p.minimalPolarity, !p.lastRequiresPF)
  const short = blockState(samples, p.minimal, p.short, minPf, p.shortPolarity, false)
  const long = blockState(samples, p.minimal + p.short, p.long, minPf, "positive", false)
  const rows = [long, short, minimal]
  const profit = long.gp + short.gp + minimal.gp, loss = long.gl + short.gl + minimal.gl
  const signed = Boolean(p.lastRequiresPF) && (p.shortPolarity === "negative" || p.minimalPolarity === "negative")
  const complete = !signed || (profit > 0 && (loss === 0 || profit / loss >= minPf))
  const state = rows.some(r => r.state === "unknown") ? "unknown" : rows.some(r => r.state === "insufficient") ? "insufficient"
    : complete && rows.every(r => r.state === "qualified") ? "qualified" : "failed"
  const required = p.long + p.short + p.minimal
  // The published PF covers the Long block, or the whole window when Last also needs PF.
  const pfProfit = p.lastRequiresPF ? profit : long.gp, pfLoss = p.lastRequiresPF ? loss : long.gl
  const pfCount = p.lastRequiresPF ? long.count + short.count + minimal.count : long.count
  const profitFactor = pfCount === 0 ? 1 : pfLoss > 0 ? pfProfit / pfLoss : pfProfit > 0 ? 999 : 1
  return { state, required, count: Math.min(samples.length, required), profitFactor, edge: rows.some(r => r.edge) }
}
function autoEvidence(policy: AutoPolicy | undefined, samples: readonly number[], skip: number, timed: number) {
  if (!policy) return undefined
  const end = Math.min(skip + policy.history, timed, samples.length)
  let n = 0, profit = 0, loss = 0
  for (let i = skip; i < end; i++) { const v = samples[i]; if (!Number.isFinite(v)) break; n++; profit += Math.max(0, v); loss += Math.max(0, -v) }
  return n >= policy.minSamples ? { mode: "set-history" as const, samples: n, profit, loss } : { mode: "fallback" as const, samples: n }
}
function autoFloor(policy: AutoPolicy | undefined, ev: ReturnType<typeof autoEvidence>) {
  if (!policy) return 0
  if (!ev || ev.mode !== "set-history") return policy.fallback
  const historic = ev.loss > 0 ? ev.profit / ev.loss : ev.profit > 0 ? policy.fallback : 1
  return Math.min(policy.cap, policy.fallback + policy.adjustment * Math.max(0, policy.fallback - historic))
}

/* ---------- bookkeeping ---------- */
type Tally = { checked: number; failed: number; skipped: number; edge: number }
const tallies: Record<string, Tally> = {}
const samples: Record<string, string[]> = {}
const tally = (key: string): Tally => (tallies[key] ??= { checked: 0, failed: 0, skipped: 0, edge: 0 })
function fail(key: string, detail: string) {
  tally(key).failed++
  const list = (samples[key] ??= [])
  if (list.length < 8) list.push(detail)
}
const policyMix = new Map<string, number>()
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

/* ---------- checks ---------- */
const files = readdirSync(directory).filter(f => /^[A-Z0-9]+-USDT\.json$/.test(f)).sort().slice(0, symbolCount)
if (!files.length) throw new Error("No observed symbol tapes")
let stageTrades = 0
const ownCloses = new Map<string, number[]>()

/** Cheap structural checks on a closed trade's carried proofs. */
function checkProofStructure(trade: Readonly<ClosedTrade>, settings: any) {
  const admission = trade.admission
  const depth = (STAGES as readonly string[]).indexOf(trade.stage)
  tally("proof.structure").checked++
  if (trade.stage === "base") { if (admission?.length) fail("proof.structure", `Base trade ${trade.id} carries a proof`); return }
  if (!admission || admission.length !== depth) return fail("proof.structure", `${trade.stage} trade ${trade.id} has ${admission?.length ?? 0} proofs, expected ${depth}`)
  const seen = new Set<string>()
  admission.forEach((p, i) => {
    const stage = STAGES[i]
    const stageMin = stage === "exec" ? settings.execMinPF ?? DEFAULT_EXEC_MIN_PF : settings.stageMinPF[stage]
    if (p.stage !== stage) fail("proof.order", `${trade.id} proof ${i} is ${p.stage}, expected ${stage}`)
    if (!p.qualified) fail("proof.qualified", `${trade.id} ${p.stage} proof is not qualified`)
    if (p.count !== p.required) fail("proof.lastN", `${trade.id} ${p.stage} count ${p.count} != required ${p.required}`)
    if (!(typeof p.profitFactor === "number" && Number.isFinite(p.profitFactor)) || p.profitFactor < p.minPF) fail("proof.pf", `${trade.id} ${p.stage} PF ${p.profitFactor} < floor ${p.minPF}`)
    if (!(p.minPF > 1)) fail("proof.floorAboveOne", `${trade.id} ${p.stage} floor ${p.minPF}`)
    if (p.minPF + 1e-12 < stageMin) fail("proof.stageFloor", `${trade.id} ${p.stage} floor ${p.minPF} below stage minimum ${stageMin}`)
    if (p.checkedAt !== trade.openedAt) fail("proof.clock", `${trade.id} ${p.stage} checked ${p.checkedAt} != opened ${trade.openedAt}`)
    if (seen.has(p.laneId)) fail("proof.distinctLanes", `${trade.id} reuses lane ${p.laneId}`)
    seen.add(p.laneId)
  })
}

/** Recompute one proof from the live tapes of the lane it names, as of its own decision clock. */
function verifyProof(proof: GateProof, owner: any, ancestorIndex: number, lanes: Record<string, any>, settings: any) {
  const sampleLane = lanes[proof.laneId], key = `proofNumbers.${proof.stage}`
  if (!sampleLane) return fail("proof.lane", `${proof.laneId} missing`)
  if (sampleLane.stage !== proof.stage) fail("proof.laneStage", `${proof.laneId}: lane stage ${sampleLane.stage} != proof ${proof.stage}`)
  if (sampleLane.symbol !== owner.symbol || sampleLane.direction !== owner.direction) fail("proof.lineage", `${proof.laneId} crosses symbol/direction of ${owner.id}`)
  const ancestors = owner.config.branch?.ancestors as { configId: string }[] | undefined
  if (ancestors?.[ancestorIndex] && sampleLane.configId !== ancestors[ancestorIndex].configId) fail("proof.lineage", `${owner.id}: ancestor ${ancestorIndex} ${ancestors[ancestorIndex].configId} != proof lane config ${sampleLane.configId}`)
  const policy: Policy | undefined = owner.config.branch?.windows?.[proof.stage]
  if (!policy) { tally(key).skipped++; return }
  const times: number[] = sampleLane.sampleTimes ?? [], all: number[] = sampleLane.samples
  let start = 0
  while (start < times.length && times[start] >= proof.checkedAt) start++
  const before = all.slice(start)
  const required = policy.long + policy.short + policy.minimal
  tally(key).checked++
  const stageMin = proof.stage === "exec" ? settings.execMinPF ?? DEFAULT_EXEC_MIN_PF : settings.stageMinPF[proof.stage]
  const ev = autoEvidence(owner.config.autoPfPolicy, before, required, before.length)
  const floor = Math.max(stageMin, owner.config.autoPfFloor ?? 0, autoFloor(owner.config.autoPfPolicy, ev))
  const mine = evaluate(before, policy, floor)
  if (proof.required !== required) fail(`${key}.required`, `${proof.laneId}: proof ${proof.required} mine ${required}`)
  if (!close(proof.minPF, floor)) fail(`${key}.floor`, `${proof.laneId}@${proof.checkedAt}: proof ${proof.minPF} mine ${floor} (${ev?.mode})`)
  if (proof.autoPf && ev && (proof.autoPf.mode !== ev.mode || proof.autoPf.samples !== ev.samples)) fail(`${key}.autoPfEvidence`, `${proof.laneId}: proof ${JSON.stringify(proof.autoPf)} mine ${JSON.stringify(ev)}`)
  if (!proof.autoPf && owner.config.autoPfPolicy) fail(`${key}.autoPfMissing`, proof.laneId)
  if (mine.state !== "qualified") { if (mine.edge) tally(key).edge++; else fail(`${key}.qualified`, `${proof.laneId}@${proof.checkedAt}: proof qualified, mine ${mine.state}`) }
  else if (!mine.edge && !close(proof.profitFactor ?? NaN, mine.profitFactor)) fail(`${key}.profitFactor`, `${proof.laneId}@${proof.checkedAt}: proof ${proof.profitFactor} mine ${mine.profitFactor}`)
}

function auditLanes(engine: TradingEngine) {
  const lanes = (engine as any).state.lanes as Record<string, any>, settings: any = engine.settings
  const snap = engine.snapshot({ laneLimit: Infinity, positionLimit: 0, ...(laneStage === "all" ? {} : { laneStage: laneStage as any }) })
  for (const row of snap.lanes as any[]) {
    if (!(GATED as readonly string[]).includes(row.stage)) continue
    const lane = lanes[row.id]
    if (!lane || lane.calculationOnly || lane.baseObservation) continue
    const policy: Policy | undefined = lane.config.branch?.windows?.[row.stage]
    const key = `lane.${row.stage}`
    if (!policy) { tally(key).skipped++; continue }
    const stageMin = row.stage === "exec" ? settings.execMinPF ?? DEFAULT_EXEC_MIN_PF : settings.stageMinPF[row.stage]
    const own = lane.samples as number[], timed = lane.timedSampleCount ?? lane.sampleTimes?.length ?? 0
    const required = policy.long + policy.short + policy.minimal
    const ev = autoEvidence(lane.config.autoPfPolicy, own, required, timed)
    const floor = Math.max(stageMin, lane.config.autoPfFloor ?? 0, autoFloor(lane.config.autoPfPolicy, ev))
    const mine = evaluate(own, policy, floor)
    tally(key).checked++
    bump(policyMix, `${row.stage}/short:${policy.shortPolarity}/last:${policy.minimalPolarity}/${policy.lastRequiresPF ? "pf" : "sign"}`)
    if (mine.state === "unknown") { tally(key).skipped++; continue }
    if (row.required !== mine.required) fail(`${key}.required`, `${row.id}: engine ${row.required} mine ${mine.required}`)
    if (row.count !== mine.count) fail(`${key}.count`, `${row.id}: engine ${row.count} mine ${mine.count}`)
    if (!close(row.minPF, floor)) fail(`${key}.floor`, `${row.id}: engine ${row.minPF} mine ${floor}`)
    const mineQualified = mine.state === "qualified"
    if (row.qualified !== mineQualified) { if (mine.edge) tally(key).edge++; else fail(`${key}.qualified`, `${row.id}: engine ${row.qualified} mine ${mine.state} (n=${own.length})`) }
    if (row.enoughSamples !== (mine.state !== "insufficient")) fail(`${key}.enough`, `${row.id}: engine ${row.enoughSamples} mine ${mine.state}`)
    if (typeof row.profitFactor === "number" && mine.state !== "insufficient" && !close(row.profitFactor, mine.profitFactor) && !mine.edge)
      fail(`${key}.profitFactor`, `${row.id}: engine ${row.profitFactor} mine ${mine.profitFactor}`)
    // A lane may only be validated (allowed to open children) when its own gate passed.
    if (row.validated && !mineQualified && !mine.edge) fail(`${key}.validatedWithoutGate`, row.id)
    if (row.stage !== "base" && row.validated) {
      const chain = lane.parentProof as GateProof[] | undefined
      if (!chain || chain.length !== GATED.indexOf(row.stage)) fail(`${key}.validatedLineage`, `${row.id}: parent proofs ${chain?.length}`)
    }
  }
  // C. a Main/Real/Exec lane's returns are exactly its own closes.
  for (const lane of Object.values(lanes) as any[]) {
    if (lane.stage === "base" || lane.stage === "live" || lane.calculationOnly || !lane.config.branch?.windows) continue
    const own = ownCloses.get(lane.id) ?? []
    tally("independence").checked++
    for (let i = 0; i < lane.samples.length; i++) {
      if (lane.samples[i] !== own[own.length - 1 - i]) { fail("independence", `${lane.id}: sample ${i} ${lane.samples[i]} != own close ${own[own.length - 1 - i]}`); break }
    }
    if (lane.closedCount !== own.length) fail("independence.count", `${lane.id}: closedCount ${lane.closedCount} != observed closes ${own.length}`)
  }
}

for (const file of files) {
  const symbol = file.replace(".json", "")
  const bars = JSON.parse(readFileSync(join(directory, file), "utf8")) as Candle[]
  if (bars.length !== scenario.tapeMinutes) throw new Error(`Expected ${scenario.tapeMinutes} bars for ${symbol}`)
  ownCloses.clear()
  const engine = new TradingEngine({ stageGateMode: "exec-branches", ...scenario.settings, symbols: [symbol] })
  const settings: any = engine.settings
  const lanes = (engine as any).state.lanes as Record<string, any>
  // B. verify every distinct proof the instant its position opens, while the tapes are exactly as the decision saw them.
  const verified = new Set<string>()
  const originalOpen = (engine as any).open.bind(engine)
  ;(engine as any).open = (lane: any, candle: Candle, mirror?: unknown, entryProof?: unknown) => {
    const position = originalOpen(lane, candle, mirror, entryProof)
    const admission = position.admission as GateProof[] | undefined
    if (admission?.length) admission.forEach((proof, i) => {
      const key = `${lane.configId}|${proof.laneId}@${proof.checkedAt}`
      if (verified.has(key)) return
      verified.add(key)
      verifyProof(proof, lane, i, lanes, settings)
    })
    return position
  }
  engine.observeStageCloses(trade => {
    stageTrades++
    if (trade.stage !== "live") {
      let list = ownCloses.get(trade.laneId)
      if (!list) ownCloses.set(trade.laneId, list = [])
      list.push(trade.netReturnPct)
    }
    checkProofStructure(trade, settings)
  })
  engine.processCandles(symbol, bars.slice(0, scenario.warmupMinutes), { eventLimit: 0 })
  const forward = bars.slice(scenario.warmupMinutes), step = 60 * 6
  for (let at = 0; at < forward.length; at += step) {
    engine.processCandles(symbol, forward.slice(at, at + step), { eventLimit: 0 })
    auditLanes(engine)
  }
  console.log(JSON.stringify({ symbol, trades: stageTrades, distinctProofsVerified: verified.size }))
}

const failed = Object.values(tallies).reduce((n, t) => n + t.failed, 0)
const result = { ordersSubmitted: 0, symbols: files.length, laneStage, stageTrades, failedChecks: failed, tallies, firstFailures: samples,
  windowPolicyMix: Object.fromEntries([...policyMix].sort()) }
writeFileSync(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ failedChecks: failed, tallies }, null, 1))
process.exitCode = failed ? 1 : 0
