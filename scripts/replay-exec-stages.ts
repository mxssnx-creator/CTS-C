import { availableParallelism } from "node:os"
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { TradingEngine, STAGES } from "../core/engine"
import { describeProfitFactor } from "../core/metrics"
import { EXIT_MODES, type Candle } from "../core/types"
import { checkExecWindows } from "../core/last-n-grid"

type Job = { file: string; family: "ordinary" | "signals"; profile: "short" | "mixed" | "full" }
type Totals = { closes:number; wins:number; profit:number; loss:number; fees:number; pnl:number }
const empty = (): Totals => ({ closes:0,wins:0,profit:0,loss:0,fees:0,pnl:0 })
type Cohort = { fit: Totals; holdout: Totals }
const cohort = (): Cohort => ({ fit:empty(),holdout:empty() })

function run({file,family,profile}: Job) {
  const start = performance.now()
  const symbol = file.split("/").at(-1)!.replace(".json","")
  const bars = JSON.parse(readFileSync(file,"utf-8")) as Candle[]
  if (bars.length !== 5760) throw new Error(`Expected 5,760 minute bars for ${symbol}`)
  const from = bars[4320].timestamp, split = bars[5040].timestamp
  const short = { long:["none"],short:[4],last:[1] }
  const mixed = { long:["none","inherit"],short:[4],last:[1,2] }
  const windows = profile === "full" ? undefined : checkExecWindows({
    base:{long:profile==="mixed"?[10,20]:[10],short:[4],last:[1]},
    main:profile==="mixed"?mixed:short, real:profile==="mixed"?mixed:short, exec:profile==="mixed"?mixed:short,
  })
  const engine = new TradingEngine({
    symbols:[symbol], stageGateMode:"exec-branches",
    catalog: {
      strategyEnabledRanges:profile==="full"?["Micro"]:["Micro","Low-Range","Minimal","Short","Normal","Long","Wide"],
      strategyTpSteps:profile==="full"?[2]:Array.from({length:29},(_,index)=>index+2), strategySlRatios:[1],
      strategyExitModes:profile==="full"?["fixed"]:[...EXIT_MODES],
      strategyIndicationTypes:family==="signals"?["Signals"]:profile==="full"?["Trend"]:["Trend","Break"],
      strategyExecWindows:windows,
    },
  })
  const stages = Object.fromEntries([...STAGES,"executed"].map(stage=>[stage,cohort()]))
  const variants: Record<string, Cohort> = {}
  engine.observeStageCloses(trade=>{
    if (trade.openedAt < from) return
    const period = trade.openedAt < split ? "fit" : "holdout"
    function record(row:Totals) {
      row.closes++
      row.wins += Number(trade.netReturnPct > 0)
      row.profit += Math.max(0,trade.netReturnPct)
      row.loss += Math.max(0,-trade.netReturnPct)
      row.fees += trade.cost
      row.pnl += trade.netPnl
    }
    record(stages[trade.stage][period])
    if (trade.executed) {
      record(stages.executed[period])
      const geometry = trade.configId.split(".branch2")[0]
      const checks = trade.configId.split(".").slice(1).filter(part=>/^(base|main|real|exec)\d/.test(part))
      const key = [geometry,trade.coordination,...checks].join("/")
      record((variants[key]??=cohort())[period])
    }
  })
  engine.processCandles(symbol,bars,{eventLimit:0})
  const snapshot = engine.snapshot({laneLimit:0,positionLimit:0})
  const executed = snapshot.stages.find(row=>row.stage==="exec")!.executed!
  if (executed.closed !== snapshot.stages.find(row=>row.stage==="live")!.closed ||
      stages.executed.fit.closes !== stages.live.fit.closes || stages.executed.holdout.closes !== stages.live.holdout.closes) {
    throw new Error(`Exec/Live paper close divergence for ${symbol}`)
  }
  return { symbol, ms:performance.now()-start, heapMiB:process.memoryUsage().heapUsed/2**20,
    lanes:Object.fromEntries(snapshot.stages.map(row=>[row.stage,row.lanes])),open:executed.open, stages, variants }
}

async function main() {
  const [directory,output,profileText="short",familyText="ordinary",countText="50",workersText="2"] = process.argv.slice(2)
  if (!directory || !output || !["short","mixed","full"].includes(profileText) || !["ordinary","signals"].includes(familyText)) {
    throw new Error("Usage: replay-exec-stages <tape directory> <results.json> [short|mixed|full] [ordinary|signals] [symbol count] [workers]")
  }
  const symbolCount = Number(countText), workerCount = Number(workersText)
  if (![symbolCount,workerCount].every(value=>Number.isSafeInteger(value)&&value>0)) throw new Error("Invalid replay symbol or worker count")
  const files = readdirSync(directory).filter(file=>/^[A-Z0-9]+-USDT\.json$/.test(file)).sort().slice(0,symbolCount)
  const jobs = files.map(file=>({file:join(directory,file),family:familyText as Job["family"],profile:profileText as Job["profile"]}))
  const fullDuration = performance.now()
  const results: ReturnType<typeof run>[] = []
  writeFileSync(output+".ndjson","")
  const workers = Math.min(jobs.length,workerCount,availableParallelism())
  await Promise.all(Array.from({length:workers},async()=>{
    while (jobs.length) {
      const job = jobs.shift()!
      const result = await new Promise<ReturnType<typeof run>>((resolve,reject)=>{
        const worker = new Worker(new URL(import.meta.url),{workerData:job,resourceLimits:{maxOldGenerationSizeMb:1024}})
        let observation: ReturnType<typeof run> | undefined
        worker.once("message",result=>{observation=result})
        worker.once("error",reject)
        worker.once("exit",code=>{
          if (code===0&&observation) resolve(observation)
          else reject(new Error(`Replay worker exited with code ${code}`))
        })
      })
      results.push(result)
      appendFileSync(output+".ndjson",JSON.stringify(result)+"\n")
      process.stderr.write(`${result.symbol} ${Math.round(result.ms)} ms · ${result.lanes.exec} Exec Sets · ${result.stages.executed.holdout.closes} held-out closes\n`)
    }
  }))
  const stages: Record<string,Cohort> = {}, variants: Record<string,Cohort> = {}
  function merge(target:Record<string,Cohort>, source:Record<string,Cohort>) {
    for (const [key, seasons] of Object.entries(source)) {
      const row = target[key]??=cohort()
      for (const period of ["fit","holdout"] as const) {
        for (const metric of Object.keys(seasons[period]) as (keyof Totals)[]) row[period][metric]+=seasons[period][metric]
      }
    }
  }
  for (const result of results) { merge(stages,result.stages); merge(variants,result.variants) }
  const addPF = (row:Totals) => ({...row,...describeProfitFactor(row.profit,row.loss,row.closes)})
  const rank = Object.entries(variants).filter(([,row])=>row.fit.closes>=30)
    .sort(([,a],[,b])=>addPF(b.fit).profitFactor-addPF(a.fit).profitFactor).slice(0,10)
    .map(([config,row])=>({config,fit:addPF(row.fit),holdout:addPF(row.holdout)}))
  writeFileSync(output,JSON.stringify({
    profile:profileText,family:familyText, symbols:results.length,workers,durationMs:performance.now()-fullDuration,
    warmupMinutes:4320, fitMinutes:720, holdoutMinutes:720,
    stages:Object.fromEntries(Object.entries(stages).map(([stage, row])=>[stage,{fit:addPF(row.fit),holdout:addPF(row.holdout)}])),
    rank, results:results.sort((a,b)=>a.symbol.localeCompare(b.symbol)),
  },null,2)+"\n")
}

if (isMainThread) void main()
else parentPort!.postMessage(run(workerData as Job))
