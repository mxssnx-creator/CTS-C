/**
 * Relate with and without sizing, both types, swept over N and X on held-out data. Paper only.
 *
 * Relate changes only the notional of a position, never its entry, exit or per-position return. So each relation's
 * trade sequence is recorded once with neutral volume (cap 1), together with the ancestor tape the engine would
 * have inherited at every entry. Every variant is then re-priced offline with the engine's own `relateAllocation`,
 * which keeps the gate, the Auto PF floor, the confidence test and the ladder identical to the live code.
 *
 * Variants are fitted on the early days only, then judged on later days of the same symbols and on 80 other symbols.
 * "Ungated" rows apply the ladder with no evidence gate at all, to show what the gate prevents.
 *
 * Usage: node --import tsx scripts/relate-sweep.ts DAYS_DIR DAYS_SCENARIO WIDE_DIR WIDE_SCENARIO RESULT_JSON [days] [symbols] [workers]
 */
import { availableParallelism } from "node:os"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { TradingEngine } from "../core/engine.ts"
import { relateAllocation } from "../core/relate.ts"
import type { Candle, ClosedTrade, RelateSettings } from "../core/types.ts"

type LaneRec = { stage: string; cfg: Record<string, unknown>; ret: number[]; pnl: number[]; end: number[]; scored: boolean[]; inherited: (number[] | undefined)[] }
type Job = { file: string; day: number; split: "fit" | "validate" | "wide"; scenario: any; warmup: number; score: number; step: number }
type Result = { split: Job["split"]; day: number; symbol: string; lanes: LaneRec[] }
const STAGES = ["main", "real", "exec"]
const NEUTRAL = { enabled: true, steps: 12, ratio: .2, stepMode: "loss", lastN: 60, minTrades: 60, minPF: 1.1, maxMultiplier: 1, maxSlRatio: .5,
  auto: { enabled: true, lastN: 30, minSamples: 8, minPF: 1.1, confidence: 1.64, inherit: true } }

function record(job: Job): Result {
  const symbol = job.file.split("/").at(-1)!.replace(".json", "")
  const all = JSON.parse(readFileSync(job.file, "utf8")) as Candle[]
  const bars = all.slice(job.day * job.step, job.day * job.step + job.warmup + job.score)
  if (bars.length !== job.warmup + job.score) throw new Error(`Short tape for ${symbol}`)
  const from = bars[job.warmup].timestamp
  const settings = structuredClone(job.scenario.settings)
  settings.coordinations.relate = { ...NEUTRAL }
  const engine = new TradingEngine({ stageGateMode: "exec-branches", ...settings, symbols: [symbol] })
  const captured = new Map<string, number[]>()
  const original = (engine as any).relateInherited.bind(engine) as (lane: any, before: number, limit: number) => number[] | undefined
  ;(engine as any).relateInherited = (lane: any, before: number, limit: number) => {
    const out = original(lane, before, limit)
    if (out?.length && before >= from) captured.set(`${lane.id}@${before}`, out.slice())
    return out
  }
  const lanes = new Map<string, LaneRec & { id: string; opened: number[] }>()
  engine.observeStageCloses((t: Readonly<ClosedTrade>) => {
    if (t.coordination !== "relate" || !STAGES.includes(t.stage)) return
    let lane = lanes.get(t.laneId)
    if (!lane) lanes.set(t.laneId, lane = { id: t.laneId, stage: t.stage, cfg: {}, ret: [], pnl: [], end: [], scored: [], inherited: [], opened: [] })
    lane.ret.push(t.netReturnPct); lane.pnl.push(t.netPnl); lane.end.push(t.closedAt); lane.opened.push(t.openedAt)
    lane.scored.push(t.openedAt >= from)
  })
  engine.processCandles(symbol, bars.slice(0, job.warmup), { eventLimit: 0 })
  engine.processCandles(symbol, bars.slice(job.warmup), { eventLimit: 0 })
  const state = (engine as any).state.lanes as Record<string, any>
  const out: LaneRec[] = []
  for (const lane of lanes.values()) {
    if (!lane.scored.some(Boolean)) continue
    const config = state[lane.id].config
    lane.cfg = { exitMode: config.exitMode, takeprofit: config.takeprofit, stoploss: config.stoploss, autoPfPolicy: config.autoPfPolicy, autoPfFloor: config.autoPfFloor }
    lane.inherited = lane.opened.map((at, i) => (lane.scored[i] ? captured.get(`${lane.id}@${at}`) : undefined))
    const { id: _id, opened: _opened, ...rest } = lane
    out.push(rest)
  }
  return { split: job.split, day: job.day, symbol, lanes: out }
}

if (!isMainThread) parentPort!.postMessage(record(workerData as Job))
else main()

/* ---------- offline re-pricing ---------- */
type Variant = { name: string; mode: "loss" | "wins"; steps: number; ratio: number; gate: "default" | "fast" | "strict" | "ungated" }
const GATES = { default: { minSamples: 8, confidence: 1.64 }, fast: { minSamples: 6, confidence: 1 }, strict: { minSamples: 12, confidence: 2.33 } } as const
function policyOf(v: Variant): RelateSettings {
  const gate = v.gate === "ungated" ? GATES.default : GATES[v.gate]
  return { enabled: true, steps: v.steps, ratio: v.ratio, stepMode: v.mode, lastN: 60, minTrades: 60, minPF: 1.1, maxMultiplier: Math.min(8, 1 + v.steps * v.ratio), maxSlRatio: .5,
    auto: { enabled: true, lastN: 30, minSamples: gate.minSamples, minPF: 1.1, confidence: gate.confidence, inherit: true } }
}
function multipliers(lane: LaneRec, v: Variant, policy: RelateSettings): number[] {
  const out: number[] = []
  const own: number[] = []
  const cap = policy.maxMultiplier
  for (let i = 0; i < lane.ret.length; i++) {
    if (lane.scored[i]) {
      if (v.gate === "ungated") {
        let k = 0
        if (v.mode === "loss") { while (k < own.length && own[k] < 0) k++; out.push(Math.min(cap, 1 + (k % (v.steps + 1)) * v.ratio)) }
        else { while (k < v.steps && k < own.length && own[k] > 0) k++; out.push(Math.min(cap, 1 + k * v.ratio)) }
      } else out.push(relateAllocation(own, lane.cfg as never, policy, own.length, lane.inherited[i]))
    } else out.push(1)
    own.unshift(lane.ret[i]); if (own.length > 71) own.length = 71
  }
  return out
}
type Acc = { n: number; up: number; gp: number; gl: number; net: number; maxMult: number; days: Map<number, number> }
const blank = (): Acc => ({ n: 0, up: 0, gp: 0, gl: 0, net: 0, maxMult: 1, days: new Map() })
function evaluate(results: Result[], v: Variant | undefined, withDrawdown: boolean) {
  const policy = v ? policyOf(v) : undefined
  const acc: Record<string, Acc> = {}, drawdowns: Record<string, number[]> = {}
  for (const res of results) {
    const paths: Record<string, { end: number; pnl: number }[]> = {}
    for (const lane of res.lanes) {
      const mult = v ? multipliers(lane, v, policy!) : undefined
      const a = (acc[lane.stage] ??= blank())
      for (let i = 0; i < lane.ret.length; i++) {
        if (!lane.scored[i]) continue
        const m = mult ? mult[i] : 1, pnl = lane.pnl[i] * m
        a.n++; if (m > 1 + 1e-9) a.up++; if (m > a.maxMult) a.maxMult = m
        if (pnl > 0) a.gp += pnl; else a.gl -= pnl
        a.net += pnl; a.days.set(res.day, (a.days.get(res.day) ?? 0) + pnl)
        if (withDrawdown) (paths[lane.stage] ??= []).push({ end: lane.end[i], pnl })
      }
    }
    if (withDrawdown) for (const [stage, path] of Object.entries(paths)) {
      path.sort((x, y) => x.end - y.end)
      let cum = 0, peak = 0, dd = 0
      for (const p of path) { cum += p.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum) }
      ;(drawdowns[stage] ??= []).push(dd)
    }
  }
  return { acc, drawdowns }
}
const pf = (a: Acc) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? 999 : NaN)
const total = (acc: Record<string, Acc>) => STAGES.reduce((s, k) => s + (acc[k]?.net ?? 0), 0)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

async function main() {
  const [daysDir, daysScenarioFile, wideDir, wideScenarioFile, output, daysText = "9", countText = "12", workersText = "3"] = process.argv.slice(2)
  if (!daysDir || !daysScenarioFile || !wideDir || !wideScenarioFile || !output) throw new Error("Usage: relate-sweep.ts DAYS_DIR DAYS_SCENARIO WIDE_DIR WIDE_SCENARIO RESULT_JSON [days] [symbols] [workers]")
  const dayScenario = JSON.parse(readFileSync(daysScenarioFile, "utf8")), wideScenario = JSON.parse(readFileSync(wideScenarioFile, "utf8"))
  const days = Number(daysText), fitDays = Math.ceil(days / 2), workers = Math.min(Number(workersText), availableParallelism())
  const dayFiles = readdirSync(daysDir).filter(f => /^[A-Z0-9]+-USDT\.json$/.test(f)).sort().slice(0, Number(countText))
  const wideFiles = readdirSync(wideDir).filter(f => /^[A-Z0-9]+-USDT\.json$/.test(f)).sort()
  const jobs: Job[] = [
    ...dayFiles.flatMap(f => Array.from({ length: days }, (_, day) => ({ file: join(daysDir, f), day, split: (day < fitDays ? "fit" : "validate") as Job["split"], scenario: dayScenario,
      warmup: dayScenario.warmupMinutes, score: dayScenario.scoreMinutes ?? 1440, step: dayScenario.stepMinutes ?? 1440 }))),
    ...wideFiles.map(f => ({ file: join(wideDir, f), day: 0, split: "wide" as const, scenario: wideScenario, warmup: wideScenario.warmupMinutes, score: wideScenario.scoreMinutes ?? 1440, step: 1440 })),
  ]
  const results: Result[] = []
  const started = performance.now()
  await Promise.all(Array.from({ length: workers }, async () => {
    while (jobs.length) {
      const job = jobs.shift()!
      results.push(await new Promise<Result>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 3072 } })
        let out: Result | undefined
        worker.once("message", r => { out = r }); worker.once("error", reject)
        worker.once("exit", code => (code === 0 && out ? resolve(out) : reject(new Error(`worker exit ${code}`))))
      }))
      if (results.length % 10 === 0) process.stderr.write(`${results.length} recorded · ${Math.round((performance.now() - started) / 1000)}s\n`)
    }
  }))
  const split = (name: Job["split"]) => results.filter(r => r.split === name)
  const sets = { fit: split("fit"), validate: split("validate"), wide: split("wide") }
  const variants: Variant[] = []
  for (const mode of ["loss", "wins"] as const) for (const steps of [2, 3, 4, 6]) for (const ratio of [.2, .4, .6, 1])
    for (const gate of ["default", "fast", "strict", "ungated"] as const) variants.push({ name: `${mode}|N${steps}|X${ratio}|${gate}`, mode, steps, ratio, gate })

  const base = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, evaluate(v, undefined, true)]))
  const rows = variants.map(v => {
    const row: Record<string, unknown> = { ...v }
    for (const [k, set] of Object.entries(sets)) {
      const e = evaluate(set, v, false), b = base[k]
      const dayNets = new Map<number, number>(), baseDay = new Map<number, number>()
      for (const stage of STAGES) {
        for (const [d, x] of e.acc[stage]?.days ?? []) dayNets.set(d, (dayNets.get(d) ?? 0) + x)
        for (const [d, x] of b.acc[stage]?.days ?? []) baseDay.set(d, (baseDay.get(d) ?? 0) + x)
      }
      const better = [...dayNets].filter(([d, x]) => x > (baseDay.get(d) ?? 0) + 1e-12).length
      const orders = STAGES.reduce((s, st) => s + (e.acc[st]?.n ?? 0), 0), up = STAGES.reduce((s, st) => s + (e.acc[st]?.up ?? 0), 0)
      row[k] = { net: total(e.acc), baseNet: total(b.acc), delta: total(e.acc) - total(b.acc), daysBetter: better, days: dayNets.size, upsizedShare: orders ? up / orders : 0,
        maxMultiplier: Math.max(...STAGES.map(st => e.acc[st]?.maxMult ?? 1)),
        realPF: pf(e.acc.real ?? blank()), baseRealPF: pf(b.acc.real ?? blank()) }
    }
    return row
  })
  // Fit-day selection among gated variants: positive on at least 80% of fit days, most improvement.
  const gated = rows.filter(r => r.gate !== "ungated")
  const eligible = gated.filter(r => { const f = r.fit as any; return f.delta > 0 && f.daysBetter >= Math.ceil(f.days * .8) && f.upsizedShare > 0 })
  const chosen = [...eligible].sort((a, b) => (b.fit as any).delta - (a.fit as any).delta).slice(0, 5)
  const finalists = [...chosen, ...rows.filter(r => r.gate === "ungated" && r.steps === 4 && r.ratio === .4)]
  const finalistDrawdown = finalists.map(r => {
    const out: Record<string, unknown> = { name: r.name }
    for (const [k, set] of Object.entries(sets)) {
      const e = evaluate(set, r as unknown as Variant, true), b = base[k]
      const dd = (x: Record<string, number[]>) => STAGES.map(st => mean(x[st] ?? [])).reduce((a, c) => a + c, 0)
      const worst = (x: Record<string, number[]>) => Math.max(0, ...STAGES.map(st => Math.max(0, ...(x[st] ?? []))))
      out[k] = { meanDrawdown: dd(e.drawdowns), baseMeanDrawdown: dd(b.drawdowns), worstDrawdown: worst(e.drawdowns), baseWorstDrawdown: worst(b.drawdowns) }
    }
    return out
  })
  writeFileSync(output, JSON.stringify({ ordersSubmitted: 0, runs: results.length, split: { fit: sets.fit.length, validate: sets.validate.length, wide: sets.wide.length },
    baseline: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { net: total(v.acc), realPF: pf(v.acc.real ?? blank()), orders: STAGES.reduce((s, st) => s + (v.acc[st]?.n ?? 0), 0) }])),
    chosenOnFit: chosen, finalistDrawdown, rows }, null, 2))
  const f = (x: unknown, d = 3) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "  –  ")
  console.log("baseline (no Relate sizing):", JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { net: +total(v.acc).toFixed(3), realPF: +f(pf(v.acc.real ?? blank())) }]))))
  console.log(`eligible on fit (net up on >=80% of fit days): ${eligible.length} of ${gated.length} gated variants`)
  const show = (r: Record<string, any>) => console.log(`${String(r.name).padEnd(24)} fit ${f(r.fit.delta, 4).padStart(8)} (${r.fit.daysBetter}/${r.fit.days}d) | validate ${f(r.validate.delta, 4).padStart(8)} (${r.validate.daysBetter}/${r.validate.days}d) | wide ${f(r.wide.delta, 4).padStart(8)} | raised ${(100 * r.validate.upsizedShare).toFixed(1)}% max x${f(r.validate.maxMultiplier, 2)}`)
  console.log("-- chosen on fit (delta net vs no Relate; positive is better)"); chosen.forEach(show)
  console.log("-- ungated series/run, N=4 X=0.4, for contrast"); rows.filter(r => r.gate === "ungated" && r.steps === 4 && r.ratio === .4).forEach(show)
  console.log("-- default gate, N=4 X=0.4"); rows.filter(r => r.gate === "default" && r.steps === 4 && r.ratio === .4).forEach(show)
}
