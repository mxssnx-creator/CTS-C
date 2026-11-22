import { availableParallelism } from "node:os"
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { createHash } from "node:crypto"
import { TradingEngine, STAGES } from "../core/engine"
import { generateEngineCatalog } from "../core/catalog"
import { EXEC_PROFILES, execProfileEnabled } from "../core/exec-profile"
import { describeProfitFactor } from "../core/metrics"
import { EXIT_MODES, type Candle, type ClosedTrade, type EngineSettings } from "../core/types"
import { checkExecWindows } from "../core/last-n-grid"

type Scenario = { tapeMinutes?: number; warmupMinutes?: number; fitMinutes?: number; groupSources?: boolean; settings?: Partial<EngineSettings> }
type Job = { file: string; family: "ordinary" | "signals"; profile: "short" | "mixed" | "full"; scenario: Scenario }
type Totals = { closes:number; wins:number; profit:number; loss:number; fees:number; pnl:number }
const empty = (): Totals => ({ closes:0,wins:0,profit:0,loss:0,fees:0,pnl:0 })
type Cohort = { fit: Totals; holdout: Totals }
const cohort = (): Cohort => ({ fit:empty(),holdout:empty() })
const periods = ["fit","holdout"] as const
const score = (row:Totals) => ({...row,...describeProfitFactor(row.profit,row.loss,row.closes)})
const scoredCohorts = (rows:Record<string,Cohort>) => Object.fromEntries(Object.entries(rows)
  .map(([key,row])=>[key,{fit:score(row.fit),holdout:score(row.holdout)}]))
function merge(target:Record<string,Cohort>, source:Record<string,Cohort>) {
  for (const [key, seasons] of Object.entries(source)) {
    const row = target[key]??=cohort()
    for (const period of periods) {
      for (const metric of Object.keys(seasons[period]) as (keyof Totals)[]) row[period][metric]+=seasons[period][metric]
    }
  }
}
function shortWidth(configId:string):string {
  const short = /\.exec\d+-(\d+)-\d+(?:-sn)?(?:-ln)?$/.exec(configId)?.[1]
  if (!short) throw new Error(`Missing Exec Short for ${configId}`)
  return short
}

function run({file,family,profile,scenario}: Job) {
  const start = performance.now()
  const symbol = file.split("/").at(-1)!.replace(".json","")
  const bytes = readFileSync(file)
  const bars = JSON.parse(bytes.toString()) as Candle[]
  const tapeMinutes = scenario.tapeMinutes ?? 5760
  if (bars.length !== tapeMinutes) throw new Error(`Expected ${tapeMinutes} minute bars for ${symbol}`)
  if (bars.some((bar,index) => bar.timestamp !== bars[0].timestamp + index * 60_000 || bar.timestamp % 60_000 !== 0)) throw new Error(`Incomplete minute tape for ${symbol}`)
  const warmupMinutes = scenario.warmupMinutes ?? 4320
  const fitMinutes = scenario.fitMinutes ?? 720
  const from = bars[warmupMinutes].timestamp, split = from + fitMinutes * 60_000
  const short = { long:["none"],short:[4],last:[1] }
  const mixed = { long:["none","inherit"],short:[4],last:[1,2] }
  const windows = profile === "full" ? undefined : checkExecWindows({
    base:{long:profile==="mixed"?[10,20]:[10],short:[4],last:[1]},
    main:profile==="mixed"?mixed:short, real:profile==="mixed"?mixed:short, exec:profile==="mixed"?mixed:short,
  })
  const engine = new TradingEngine({
    stageGateMode:"exec-branches", ...scenario.settings, symbols:[symbol],
    catalog: {
      strategyEnabledRanges:profile==="full"?["Micro"]:["Micro","Low-Range","Minimal","Short","Normal","Long","Wide"],
      strategyTpSteps:profile==="full"?[2]:Array.from({length:29},(_,index)=>index+2), strategySlRatios:[1],
      strategyExitModes:profile==="full"?["fixed"]:[...EXIT_MODES],
      strategyIndicationTypes:family==="signals"?["Signals"]:profile==="full"?["Trend"]:["Trend","Break"],
      strategyExecWindows:windows,
      ...scenario.settings?.catalog,
    },
  })
  const stages = Object.fromEntries([...STAGES,"executed"].map(stage=>[stage,cohort()]))
  const postStages = Object.fromEntries(STAGES.filter(stage=>stage!=="live").map(stage=>[stage,cohort()]))
  const settings = engine.settings
  const execShorts = [...new Set([...checkExecWindows(settings.catalog.strategyExecWindows).exec.short,
    ...EXEC_PROFILES.filter(profile=>execProfileEnabled(settings,profile)).flatMap(profile=>profile.windows.exec.short)])].sort((a,b)=>a-b)
  const shortBooks = Object.fromEntries(execShorts.map(count=>[count,cohort()]))
  const shortAccepted = Object.fromEntries(execShorts.map(count=>[count,cohort()]))
  const variants: Record<string, Cohort> = {}
  const groups: Record<string, Cohort> = {}
  const sources = scenario.groupSources ? new Map(generateEngineCatalog(settings,settings.symbolFees?.[symbol])
    .map(config=>[config.id,config.execProfile??config.indicationSourceId??config.type])) : undefined
  const distinct = {fit:new Map<string,{n:number;returns:number}>(),holdout:new Map<string,{n:number;returns:number}>()}
  const shortPaths = Object.fromEntries(execShorts.map(count=>[count,{fit:new Set<string>(),holdout:new Set<string>()}]))
  const awaitingMirror = new Map<string,Readonly<ClosedTrade>>()
  let crossingCloses = 0
  engine.observeStageCloses(trade=>{
    if (trade.executed) awaitingMirror.set(trade.id,trade)
    if (trade.stage==="live") {
      const parent = awaitingMirror.get(trade.parentPositionId??"")
      if (!parent||parent.openedAt!==trade.openedAt||parent.closedAt!==trade.closedAt||parent.direction!==trade.direction||
          parent.netReturnPct!==trade.netReturnPct||parent.cost!==trade.cost||parent.quantity!==trade.quantity||
          parent.entryPrice!==trade.entryPrice||parent.exitPrice!==trade.exitPrice) throw new Error(`Exec/Live fill divergence for ${symbol}`)
      awaitingMirror.delete(parent.id)
    }
    if (trade.openedAt < from) return
    if (trade.openedAt < split && trade.closedAt >= split) {
      if (trade.executed) crossingCloses++
      return
    }
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
    if (trade.progressionProof || trade.executed) record(postStages[trade.stage][period])
    if (trade.stage === "exec") {
      const short = shortWidth(trade.configId)
      record(shortBooks[short][period])
      if (trade.executed) record(shortAccepted[short][period])
    }
    const geometry = trade.configId.split(".branch2")[0]
    if (sources) {
      const source = sources.get(geometry)
      if (!source) throw new Error(`Missing geometry for ${trade.configId}`)
      const family = source.startsWith("rsi-") ? "RSI" : source.startsWith("parabolic-sar-") || source.startsWith("sar-") ? "Parabolic SAR" : source
      for (const group of new Set([source,family])) {
        const key = `${group}/${trade.stage}`
        record((groups[key]??=cohort())[period])
        if (trade.executed) record((groups[`${group}/executed`]??=cohort())[period])
      }
    }
    if (trade.executed) {
      record(stages.executed[period])
      const key = [trade.configId,trade.coordination,trade.direction].join("/")
      record((variants[key]??=cohort())[period])
      const [type,range] = geometry.slice(3).split(/_(?=(?:Micro|Low-Range|Minimal|Short|Normal|Long|Wide)_)/,2)
      for (const group of [type, range?.split("_")[0], trade.coordination, trade.executionProof?.autoPf?.mode ?? "static"].filter(Boolean)) {
        record((groups[group]??=cohort())[period])
      }
      const path = [trade.direction,trade.openedAt,trade.closedAt,trade.entryPrice,trade.exitPrice].join("/")
      const outcome = distinct[period].get(path) ?? {n:0,returns:0}
      outcome.n++
      outcome.returns += trade.netReturnPct
      distinct[period].set(path,outcome)
      shortPaths[shortWidth(trade.configId)][period].add(path)
    }
  })
  engine.processCandles(symbol,bars,{eventLimit:0})
  const snapshot = engine.snapshot({laneStage:"exec",positionStage:"exec"})
  const executed = snapshot.stages.find(row=>row.stage==="exec")!.executed!
  if (awaitingMirror.size || executed.closed !== snapshot.stages.find(row=>row.stage==="live")!.closed ||
      stages.executed.fit.closes !== stages.live.fit.closes || stages.executed.holdout.closes !== stages.live.holdout.closes) {
    throw new Error(`Exec/Live paper close divergence for ${symbol}`)
  }
  const shortCoverage = Object.fromEntries(execShorts.map(count=>[count,{sets:0,ready:0}]))
  for (const lane of snapshot.lanes) if (lane.current) {
    const row = shortCoverage[shortWidth(lane.configId)]
    row.sets++
    row.ready += Number(lane.enoughSamples)
  }
  const unique = {fit:distinct.fit.size,holdout:distinct.holdout.size}
  const distinctReturns = Object.fromEntries(periods.map(period=>{
    let profit=0,loss=0
    for (const path of distinct[period].values()) {
      const net=path.returns/path.n
      profit+=Math.max(0,net)
      loss+=Math.max(0,-net)
    }
    return [period,{closed:unique[period],profit,loss}]
  }))
  return { symbol, ms:performance.now()-start, heapMiB:process.memoryUsage().heapUsed/2**20,
    tape:{firstClose:bars[0].timestamp,lastClose:bars.at(-1)!.timestamp,sha256:createHash("sha256").update(bytes).digest("hex")},
    lanes:Object.fromEntries(snapshot.stages.map(row=>[row.stage,row.currentLanes])),
    enoughSamples:Object.fromEntries(snapshot.stages.map(row=>[row.stage,row.currentEnoughSamples])),
    baseCandidates:snapshot.stages[0].baseCandidates,
    open:snapshot.positions.filter(position=>position.executed&&position.openedAt>=from).length,
    unique,distinctReturns,crossingCloses,stages,postStages,shortBooks,shortAccepted,shortCoverage,variants,groups,
    shortUnique:Object.fromEntries(execShorts.map(n=>[n,{fit:shortPaths[n].fit.size,holdout:shortPaths[n].holdout.size}])) }
}

async function main() {
  const [directory,output,profileText="short",familyText="ordinary",countText="50",workersText="2",scenarioFile] = process.argv.slice(2)
  if (!directory || !output || !["short","mixed","full"].includes(profileText) || !["ordinary","signals"].includes(familyText)) {
    throw new Error("Usage: replay-exec-stages <tape directory> <results.json> [short|mixed|full] [ordinary|signals] [symbol count] [workers] [scenario.json]")
  }
  const symbolCount = Number(countText), workerCount = Number(workersText)
  if (![symbolCount,workerCount].every(value=>Number.isSafeInteger(value)&&value>0)) throw new Error("Invalid replay symbol or worker count")
  const files = readdirSync(directory).filter(file=>/^[A-Z0-9]+-USDT\.json$/.test(file)).sort().slice(0,symbolCount)
  if (!files.length) throw new Error("No observed symbol tapes")
  const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile,"utf8")) as Scenario : {}
  const tapeMinutes = scenario.tapeMinutes ?? 5760, warmupMinutes = scenario.warmupMinutes ?? 4320, fitMinutes = scenario.fitMinutes ?? 720
  if (!Number.isSafeInteger(tapeMinutes) || !Number.isSafeInteger(warmupMinutes) || warmupMinutes < 1 || warmupMinutes >= tapeMinutes ||
      !Number.isSafeInteger(fitMinutes) || fitMinutes < 0 || warmupMinutes + fitMinutes > tapeMinutes) throw new Error("Invalid chronological replay slices")
  const jobs = files.map(file=>({file:join(directory,file),family:familyText as Job["family"],profile:profileText as Job["profile"],scenario}))
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
      process.stderr.write(`${result.symbol} ${Math.round(result.ms)} ms · ${result.lanes.exec} Exec Sets · ${result.stages.executed.fit.closes}/${result.stages.executed.holdout.closes} scored closes\n`)
    }
  }))
  const stages:Record<string,Cohort> = {}, variants:Record<string,Cohort> = {}, groups:Record<string,Cohort> = {}
  const postStages:Record<string,Cohort> = {}, shortBooks:Record<string,Cohort> = {}, shortAccepted:Record<string,Cohort> = {}
  const shortCoverage:Record<string,{sets:number;ready:number}> = {}
  const shortUnique:Record<string,{fit:number;holdout:number}> = {}
  for (const result of results) {
    merge(stages,result.stages); merge(variants,result.variants); merge(groups,result.groups)
    merge(postStages,result.postStages); merge(shortBooks,result.shortBooks); merge(shortAccepted,result.shortAccepted)
    for (const [count,observed] of Object.entries(result.shortCoverage)) {
      const row = shortCoverage[count]??={sets:0,ready:0}
      row.sets += observed.sets
      row.ready += observed.ready
      const unique = shortUnique[count]??={fit:0,holdout:0}
      for (const period of periods) unique[period] += result.shortUnique[count][period]
    }
  }
  const distinctReturns = Object.fromEntries(periods.map(period=>{
    const totals={closed:0,profit:0,loss:0}
    for (const result of results) {
      const row = result.distinctReturns[period]
      totals.closed+=row.closed
      totals.profit+=row.profit
      totals.loss+=row.loss
    }
    return [period,{...totals,...describeProfitFactor(totals.profit,totals.loss,totals.closed)}]
  }))
  const rank = Object.entries(variants).filter(([,row])=>row.fit.closes>=30)
    .sort(([,a],[,b])=>score(b.fit).profitFactor-score(a.fit).profitFactor).slice(0,10)
    .map(([config,row])=>({config,fit:score(row.fit),holdout:score(row.holdout)}))
  writeFileSync(output,JSON.stringify({
    profile:profileText,family:familyText, symbols:results.length,workers,durationMs:performance.now()-fullDuration,
    warmupMinutes, fitMinutes, holdoutMinutes:tapeMinutes-warmupMinutes-fitMinutes, settings:scenario.settings,
    stages:scoredCohorts(stages),postStages:scoredCohorts(postStages),groups:scoredCohorts(groups),
    execShort:{coverage:shortCoverage,book:scoredCohorts(shortBooks),accepted:scoredCohorts(shortAccepted),unique:shortUnique},
    unique:Object.fromEntries(periods.map(period=>[period,distinctReturns[period].closed])),
    distinctReturns,rank,results:results.sort((a,b)=>a.symbol.localeCompare(b.symbol)),
  },null,2)+"\n")
}

if (isMainThread) void main()
else parentPort!.postMessage(run(workerData as Job))
