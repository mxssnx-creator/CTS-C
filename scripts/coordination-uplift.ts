/**
 * Held-out, multi-day comparison of Normal, Axis, Block, DCA and Relate on identical entries. Paper only.
 *
 * Each (symbol, day) job is a fresh engine: `warmup` minutes of prehistory, then `score` minutes that are scored.
 * Windows roll forward by `step` minutes, so every scored day uses only earlier closed candles. PF is computed
 * independently per stage and coordination, as return-PF (per-position net return %) and cash-PF (net P&L).
 * Paired analysis matches a coordination's position to Normal's position of the same configuration, entry
 * clock and side, so the comparison cannot be explained by different entries. A bootstrap over days gives an
 * interval for the PF ratio; with few distinct paths that interval is wide, and it is reported as is.
 *
 * Usage: node --import tsx scripts/coordination-uplift.ts TAPE_DIR RESULT_JSON SCENARIO_JSON [days] [symbols] [workers]
 */
import { availableParallelism } from "node:os"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { TradingEngine } from "../core/engine.ts"
import type { Candle, ClosedTrade } from "../core/types.ts"

type Acc = { n: number; wins: number; gp: number; gl: number; cgp: number; cgl: number; net: number; paths: number; pgp: number; pgl: number; upsized: number; adds: number }
const blank = (): Acc => ({ n: 0, wins: 0, gp: 0, gl: 0, cgp: 0, cgl: 0, net: 0, paths: 0, pgp: 0, pgl: 0, upsized: 0, adds: 0 })
const merge = (a: Acc, b: Acc) => { for (const k of Object.keys(a) as (keyof Acc)[]) a[k] += b[k] }
type Slim = { stage: string; coord: string; config: string; dir: string; at: number; end: number; p0: number; exit: number; r: number; pnl: number; notional: number; fills: number }
type Job = { file: string; day: number; scenario: any; warmup: number; score: number; step: number }
type Result = { symbol: string; day: number; overall: Record<string, Acc>; pairC: Record<string, Acc>; pairN: Record<string, Acc>; rejected: Record<string, Acc> }

function addTrade(a: Acc, t: Slim) {
  a.n++
  if (t.r > 0) { a.wins++; a.gp += t.r } else a.gl -= t.r
  if (t.pnl > 0) a.cgp += t.pnl; else a.cgl -= t.pnl
  a.net += t.pnl
  if (t.fills > 1) a.adds++
}

function runJob(job: Job): Result {
  const symbol = job.file.split("/").at(-1)!.replace(".json", "")
  const all = JSON.parse(readFileSync(job.file, "utf8")) as Candle[]
  const bars = all.slice(job.day * job.step, job.day * job.step + job.warmup + job.score)
  if (bars.length !== job.warmup + job.score) throw new Error(`Short tape for ${symbol} day ${job.day}`)
  const from = bars[job.warmup].timestamp
  const engine = new TradingEngine({ stageGateMode: "exec-branches", ...job.scenario.settings, symbols: [symbol] })
  const trades: Slim[] = []
  engine.observeStageCloses((t: Readonly<ClosedTrade>) => {
    if (t.openedAt < from) return
    trades.push({ stage: t.stage, coord: t.coordination, config: t.configId, dir: t.direction, at: t.openedAt, end: t.closedAt, p0: t.fills[0].price,
      exit: t.exitPrice, r: t.netReturnPct, pnl: t.netPnl, notional: t.notional, fills: t.fills.length })
  })
  engine.processCandles(symbol, bars.slice(0, job.warmup), { eventLimit: 0 })
  engine.processCandles(symbol, bars.slice(job.warmup), { eventLimit: 0 })

  const overall: Record<string, Acc> = {}, pairC: Record<string, Acc> = {}, pairN: Record<string, Acc> = {}, rejected: Record<string, Acc> = {}
  const get = (m: Record<string, Acc>, k: string) => (m[k] ??= blank())
  const paths = new Map<string, { n: number; sum: number }>()
  for (const t of trades) {
    addTrade(get(overall, `${t.stage}|${t.coord}`), t)
    const key = `${t.stage}|${t.coord}|${t.dir}|${t.at}|${t.end}|${t.p0}|${t.exit}`
    const p = paths.get(key)
    if (p) { p.n++; p.sum += t.r } else paths.set(key, { n: 1, sum: t.r })
  }
  for (const [key, p] of paths) {
    const k = key.split("|").slice(0, 2).join("|"), a = get(overall, k), mean = p.sum / p.n
    a.paths++; a.pgp += Math.max(0, mean); a.pgl += Math.max(0, -mean)
  }
  // Pair by configuration, side and entry clock within a stage.
  const byStage = new Map<string, Map<string, { normal?: Slim; others: Map<string, Slim> }>>()
  for (const t of trades) {
    if (t.stage === "base" || t.stage === "live") continue
    let stage = byStage.get(t.stage)
    if (!stage) byStage.set(t.stage, stage = new Map())
    const k = `${t.config}|${t.dir}|${t.at}`
    let row = stage.get(k)
    if (!row) stage.set(k, row = { others: new Map() })
    if (t.coord === "normal") row.normal ??= t
    else row.others.set(t.coord, t)
  }
  for (const [stage, rows] of byStage) {
    for (const row of rows.values()) {
      if (!row.normal) continue
      for (const coord of ["axis", "block", "dca", "relate"]) {
        const other = row.others.get(coord), k = `${stage}|${coord}`
        if (other) {
          addTrade(get(pairC, k), other); addTrade(get(pairN, k), row.normal)
          if (other.notional > row.normal.notional * (1 + 1e-9)) get(pairC, k).upsized++
        } else addTrade(get(rejected, k), row.normal)
      }
    }
  }
  return { symbol, day: job.day, overall, pairC, pairN, rejected }
}

if (!isMainThread) {
  const job = workerData as Job
  parentPort!.postMessage(runJob(job))
} else {
  main()
}

const pf = (gp: number, gl: number) => (gl > 0 ? gp / gl : gp > 0 ? 999 : NaN)
async function main() {
  const [directory, output, scenarioFile, daysText = "9", countText = "12", workersText = "3"] = process.argv.slice(2)
  if (!directory || !output || !scenarioFile) throw new Error("Usage: coordination-uplift.ts TAPE_DIR RESULT_JSON SCENARIO_JSON [days] [symbols] [workers]")
  const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"))
  const warmup = scenario.warmupMinutes as number, score = scenario.scoreMinutes ?? 1440, step = scenario.stepMinutes ?? 1440
  const days = Number(daysText), workers = Math.min(Number(workersText), availableParallelism())
  const files = readdirSync(directory).filter(f => /^[A-Z0-9]+-USDT\.json$/.test(f)).sort().slice(0, Number(countText))
  const jobs: Job[] = files.flatMap(f => Array.from({ length: days }, (_, day) => ({ file: join(directory, f), day, scenario, warmup, score, step })))
  const results: Result[] = []
  const started = performance.now()
  await Promise.all(Array.from({ length: workers }, async () => {
    while (jobs.length) {
      const job = jobs.shift()!
      results.push(await new Promise<Result>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 2048 } })
        let out: Result | undefined
        worker.once("message", r => { out = r }); worker.once("error", reject)
        worker.once("exit", code => (code === 0 && out ? resolve(out) : reject(new Error(`worker exit ${code}`))))
      }))
      process.stderr.write(`${results.length} runs · ${Math.round((performance.now() - started) / 1000)}s\n`)
    }
  }))

  // Aggregate: overall, and per day for the bootstrap.
  const sum = (pick: (r: Result) => Record<string, Acc>, filter: (r: Result) => boolean = () => true) => {
    const out: Record<string, Acc> = {}
    for (const r of results) if (filter(r)) for (const [k, a] of Object.entries(pick(r))) merge((out[k] ??= blank()), a)
    return out
  }
  const overall = sum(r => r.overall), pairC = sum(r => r.pairC), pairN = sum(r => r.pairN), rejected = sum(r => r.rejected)
  const perDay = Array.from({ length: days }, (_, d) => ({ pairC: sum(r => r.pairC, r => r.day === d), pairN: sum(r => r.pairN, r => r.day === d) }))
  let seed = 12345
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  const bootstrap = (key: string, field: "return" | "cash") => {
    const ratios: number[] = []
    for (let b = 0; b < 2000; b++) {
      let cgp = 0, cgl = 0, ngp = 0, ngl = 0
      for (let i = 0; i < days; i++) {
        const d = perDay[Math.floor(rand() * days)], c = d.pairC[key], n = d.pairN[key]
        if (!c || !n) continue
        if (field === "return") { cgp += c.gp; cgl += c.gl; ngp += n.gp; ngl += n.gl } else { cgp += c.cgp; cgl += c.cgl; ngp += n.cgp; ngl += n.cgl }
      }
      const a = pf(cgp, cgl), c = pf(ngp, ngl)
      if (Number.isFinite(a) && Number.isFinite(c) && c > 0) ratios.push(a / c)
    }
    ratios.sort((x, y) => x - y)
    return ratios.length ? { low: ratios[Math.floor(ratios.length * 0.025)], median: ratios[Math.floor(ratios.length * 0.5)], high: ratios[Math.floor(ratios.length * 0.975)] } : null
  }
  const dayWins = (key: string, field: "return" | "cash") => {
    let wins = 0, counted = 0
    for (const d of perDay) {
      const c = d.pairC[key], n = d.pairN[key]
      if (!c || !n || !c.n) continue
      const a = field === "return" ? pf(c.gp, c.gl) : pf(c.cgp, c.cgl), b = field === "return" ? pf(n.gp, n.gl) : pf(n.cgp, n.cgl)
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      counted++; if (a > b) wins++
    }
    return { wins, days: counted }
  }
  const rows = Object.keys(overall).sort().map(key => {
    const o = overall[key], c = pairC[key], n = pairN[key], j = rejected[key]
    return { key, trades: o.n, distinctPaths: o.paths, returnPF: pf(o.gp, o.gl), cashPF: pf(o.cgp, o.cgl), distinctPathPF: pf(o.pgp, o.pgl), net: o.net, winRate: o.n ? o.wins / o.n : null,
      addShare: o.n ? o.adds / o.n : null,
      paired: c && n ? { matched: c.n, returnPF: pf(c.gp, c.gl), normalReturnPF: pf(n.gp, n.gl), cashPF: pf(c.cgp, c.cgl), normalCashPF: pf(n.cgp, n.cgl),
        upsizedShare: c.n ? c.upsized / c.n : null, returnRatioCI: bootstrap(key, "return"), cashRatioCI: bootstrap(key, "cash"),
        returnDayWins: dayWins(key, "return"), cashDayWins: dayWins(key, "cash"),
        rejectedByCoordination: j ? { trades: j.n, normalReturnPF: pf(j.gp, j.gl), normalCashPF: pf(j.cgp, j.cgl) } : null } : null }
  })
  writeFileSync(output, JSON.stringify({ ordersSubmitted: 0, symbols: files.length, days, warmupMinutes: warmup, scoreMinutes: score, runs: results.length, rows }, null, 2))
  const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "  –  " : x.toFixed(d).padStart(6))
  console.log("stage|coord      trades  paths  retPF  cashPF | matched  retPF(c) retPF(n) cashPF(c) cashPF(n) | ratio95%(ret)      dayWins(ret)")
  for (const r of rows) {
    const p = r.paired, ci = p?.returnRatioCI
    console.log(`${r.key.padEnd(13)} ${String(r.trades).padStart(7)} ${String(r.distinctPaths).padStart(6)} ${f(r.returnPF)} ${f(r.cashPF)} | ${p ? `${String(p.matched).padStart(7)} ${f(p.returnPF)}  ${f(p.normalReturnPF)}  ${f(p.cashPF)}   ${f(p.normalCashPF)}  | ${ci ? `${f(ci.low)}..${f(ci.high)}` : "   –   "}   ${p.returnDayWins.wins}/${p.returnDayWins.days}` : ""}`)
  }
}
