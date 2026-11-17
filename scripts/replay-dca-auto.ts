/** Replay DCA evaluation on contiguous, already recorded one-minute candles. */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TradingEngine, validateObservedCandles } from "../core/engine"
import { describeProfitFactor } from "../core/metrics"
import type { Candle, ClosedTrade, DcaAutoPolicy, Stage } from "../core/types"

async function main() {
  const [, , directory, output] = process.argv
  if (!directory || !output) throw new Error("Usage: node --import tsx scripts/replay-dca-auto.ts INPUT_DIR OUTPUT_JSON")
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    warmup: number; start: number; cutoff: number; datasets: { symbol: string; file: string; sha256: string }[]
  }
  if (!Number.isInteger(manifest.warmup) || manifest.warmup < 1 || manifest.warmup > 4320 || !manifest.datasets.length) {
    throw new Error("Missing or invalid replay manifest")
  }
  const data = await Promise.all(manifest.datasets.map(async entry => {
    const bytes = await readFile(join(directory, entry.file))
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Recorded bars changed for ${entry.symbol}`)
    const bars = JSON.parse(bytes.toString()) as Candle[]
    validateObservedCandles(bars)
    if (bars.length !== manifest.warmup + 720 || bars.some((bar, i) => bar.timestamp !== manifest.start + (i + 1) * 60_000) ||
        bars.at(-1)?.timestamp !== manifest.cutoff) throw new Error(`Noncontiguous history for ${entry.symbol}`)
    return { symbol: entry.symbol, bars }
  }))

  const scenarios: { name: string; distance: number; auto?: DcaAutoPolicy }[] = [
    { name: "manual-default", distance: 1 },
    { name: "manual-narrow", distance: .15 },
    { name: "auto-30-15", distance: .15, auto: { enabled: true, lastN: 30, minSamples: 15, minPF: 1.1 } },
    { name: "auto-8-5", distance: .15, auto: { enabled: true, lastN: 8, minSamples: 5, minPF: 1.1 } },
  ]
  const stages = ["base", "main", "real", "live"] as const
  const summary = []
  for (const scenario of scenarios) {
    const totals = Object.fromEntries(stages.map(stage => [
      stage, { entries: 0, adds: 0, open: 0, lanes: 0, validated: 0 },
    ])) as Record<Stage, { entries: number; adds: number; open: number; lanes: number; validated: number }>
    const closes: ClosedTrade[] = []
    for (const { symbol, bars } of data) for (const indication of ["Trend", "Signals"]) {
      let engine = new TradingEngine({
        symbols: [symbol], stageGateMode: "processed-sets", liveEntryMode: "real-mirror",
        stageLastN: { base: 20, main: 8, real: 8 }, stageMinPF: { base: 1.1, main: 1.1, real: 1.1 },
        catalog: {
          strategyIndicationTypes: [indication], strategyEnabledRanges: ["Micro"], strategyTpSteps: [2, 3, 5],
          strategySlRatios: [.5, 1, 1.5], strategyExitModes: ["fixed", "trailing"],
          strategySignalTimeframes: [1], strategySignalPeriods: [20], strategySignalsSources: ["sig-ema-cross-s"],
          autoPfEnabled: true, autoPfRatio: .2, autoPfMax: 2, makerFeePct: .02, takerFeePct: .05, slippagePctOfFees: 10,
        },
        coordinations: {
          axis: { enabled: false, previous: 8, last: 3, outcome: "any" },
          block: { enabled: false, steps: 3, ratio: .2, mode: "shared" },
          dca: { enabled: true, steps: 2, distancePct: scenario.distance, multiplier: 2, auto: scenario.auto },
        },
      })
      engine.processCandles(symbol, bars.slice(0, manifest.warmup), { eventLimit: 0 })
      const warm = engine.exportState()
      for (const lane of Object.values(warm.lanes)) delete lane.open
      engine = TradingEngine.fromOwnedCheckpoint(warm)
      for (const event of engine.processCandles(symbol, bars.slice(manifest.warmup))) {
        if (JSON.parse(event.laneId)[4] !== "dca") continue
        if (event.type === "opened") totals[event.stage].entries++
        if (event.type === "added") totals[event.stage].adds++
        if (event.trade) closes.push(event.trade)
      }
      const snapshot = engine.snapshot()
      for (const lane of snapshot.lanes) if (lane.current && lane.coordination === "dca") {
        totals[lane.stage].lanes++
        totals[lane.stage].validated += Number(lane.validated)
        totals[lane.stage].open += Number(lane.isOpen)
      }
      if (engine.pendingIntents().length) throw new Error("Replay created an execution intent")
    }
    const rows = stages.map(stage => {
      const trades = closes.filter(trade => trade.stage === stage)
      let gp = 0, gl = 0, cashGain = 0, cashLoss = 0
      const realizedAt = new Map<number, number>()
      for (const trade of trades) {
        gp += Math.max(0, trade.netReturnPct)
        gl += Math.max(0, -trade.netReturnPct)
        cashGain += Math.max(0, trade.netPnl)
        cashLoss += Math.max(0, -trade.netPnl)
        realizedAt.set(trade.closedAt, (realizedAt.get(trade.closedAt) ?? 0) + trade.netPnl)
      }
      let balance = 0, peak = 0, realizedDrawdown = 0
      for (const t of [...realizedAt.keys()].sort((a, b) => a - b)) {
        balance += realizedAt.get(t)!
        peak = Math.max(peak, balance)
        realizedDrawdown = Math.max(realizedDrawdown, peak - balance)
      }
      return { stage, ...totals[stage], closes: trades.length,
        returnPF: describeProfitFactor(gp, gl, trades.length),
        cashPF: describeProfitFactor(cashGain, cashLoss, trades.length),
        netPnl: cashGain - cashLoss, realizedDrawdown }
    })
    summary.push({ scenario, rows })
    console.log(JSON.stringify({ scenario: scenario.name, live: rows[3] }))
  }
  await writeFile(output, JSON.stringify({
    manifest, orderIntents: 0, summary,
    scope: "Twelve-hour retrospective CTS-C Micro paper replay. Each symbol and indication has its own engine. Realized drawdown sums settled model P&L by timestamp in unit budgets. Open exposure, margin, physical fills and account equity are outside this calculation.",
  }, null, 2) + "\n")
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
