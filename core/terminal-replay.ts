import { generateEngineCatalog, generateStrategyCatalog, STRATEGY_RANGES } from "./catalog"
import { EXEC_PROFILES } from "./exec-profile"
import { replayStrategy,strategySignalTrace } from "./replay"
import { aggregateCostNormalizedResults, describeProfitFactor } from "./metrics"
import { STAGES, TradingEngine, windowMetrics } from "./engine"
import { MAX_RESEARCH_CANDLES, type MarketCandle } from "./market"
import type { StrategyConfig, PseudoPosition, EngineSettings, ClosedTrade } from "./types"

function metrics(positions: PseudoPosition[]) {
  const closed = positions.filter(p => p.status === "closed")
  const values = closed.map(p => p.result ?? 0)
  const a = aggregateCostNormalizedResults(values)
  let cumulative = 0, peak = 0, maxDrawdownPct = 0
  for (const value of values) { cumulative += value; peak = Math.max(peak, cumulative); maxDrawdownPct = Math.max(maxDrawdownPct, peak - cumulative) }
  return { trades: closed.length, pf: closed.length ? a.profitFactor : null, pfState: a.pfState, netReturnSumPct: a.netR, maxDrawdownPct, winRate: a.winRate * 100, long: closed.filter(p => p.direction === "long").length, short: closed.filter(p => p.direction === "short").length, open: positions.filter(p => p.status === "open").length }
}

/** Parameters are ranked on a chronological training slice only. Holdout is
 * read after the shortlist is frozen and never updates engine settings. */
function* replaySteps(symbol: string, candles: MarketCandle[], settings: Record<string, unknown> = {}) {
  if (candles.length < 100 || candles.length > MAX_RESEARCH_CANDLES) throw new Error(`Replay needs 100..${MAX_RESEARCH_CANDLES} chronological candles`)
  const split = Math.floor(candles.length * .65)
  const barSeconds=Number(settings.replayBarSeconds??0)
  if(!Number.isFinite(barSeconds)||barSeconds<0)throw new Error("Invalid replay interval")
  const train = candles.slice(0, split).map(c => ({ ...c, timestamp: (c.time+barSeconds) * 1000 }))
  const test = candles.slice(split).map(c => ({ ...c, timestamp: (c.time+barSeconds) * 1000 }))
  const branches = settings.stageGateMode === "parent-branches" || settings.stageGateMode === "exec-branches"
  const configs = generateStrategyCatalog("terminal-research", branches ? { ...settings, strategyLastNGrid: undefined } : settings).filter(c=>barSeconds===10?(c.signalTimeframeMinutes??1)<1:(c.signalTimeframeMinutes??1)>=1)
  const minSamples = Math.max(1, Math.min(200, Number(settings.prevPosWindow??settings.mainEvalPosCount) || 20))
  const minPf = Math.max(1, Number(settings.baseProfitFactor) || 1.05)
  const evaluated = [] as {config:StrategyConfig;score:ReturnType<typeof metrics>;enough:boolean;passed:boolean}[]
  const trainTraces=new Map<string,ReturnType<typeof strategySignalTrace>>(),testTraces=new Map<string,ReturnType<typeof strategySignalTrace>>()
  const trace=(config:StrategyConfig,holdout=false)=>{
    const key=JSON.stringify([config.type,config.position_cost_step,config.signalTimeframeMinutes??1,config.indicationSourceId??null]),cache=holdout?testTraces:trainTraces
    let value=cache.get(key)
    if(!value){value=strategySignalTrace(holdout?test:train,config,holdout?train:[]);cache.set(key,value)}return value
  }
  for(const config of configs){
    const positions = replayStrategy(symbol, train, config,train.length*2,[],trace(config))
    const score = metrics(positions)
    let enough = score.trades >= minSamples, passed = enough && (score.pf ?? 0) >= Math.max(minPf,config.autoPfFloor??0)
    if (config.autoPfPolicy) {
      const sets = (["long","short"] as const).map(direction=>{
        const closed = positions.filter(position=>position.direction===direction&&position.status==="closed").reverse()
        const samples = closed.map(position=>position.result!)
        return windowMetrics({config,samples,closedCount:samples.length,timedSampleCount:samples.length},minSamples,minPf)
      })
      enough = sets.some(set=>set.enoughSamples)
      passed = sets.some(set=>set.qualified)
    }
    evaluated.push({config,score,enough,passed})
    yield
  }
  const selected: typeof evaluated = []
  for (const range of STRATEGY_RANGES) {
    const candidates = evaluated.filter(v => v.config.range === range).sort((a, b) => Number(b.passed) - Number(a.passed) || Number(b.enough) - Number(a.enough) || (b.score.pf ?? -1) - (a.score.pf ?? -1) || b.score.netReturnSumPct - a.score.netReturnSumPct || a.config.id.localeCompare(b.config.id))
    selected.push(...candidates.slice(0, 3))
  }
  const rows=[] as {id:string;range:StrategyConfig['range'];tactic:string;indicationSourceId?:string;tpStep:StrategyConfig['tpStep'];slRatio:StrategyConfig['slRatio'];exitMode:StrategyConfig['exitMode'];lookback:number;signalTimeframeMinutes:number;training:ReturnType<typeof metrics>;trainingPassed:boolean;holdout:ReturnType<typeof metrics>}[]
  for(const {config,score,passed} of selected){rows.push({
    id: config.id, range: config.range, tactic: config.type,...(config.indicationSourceId?{indicationSourceId:config.indicationSourceId}:{}), tpStep: config.tpStep, slRatio: config.slRatio, exitMode: config.exitMode,lookback:config.position_cost_step,signalTimeframeMinutes:config.signalTimeframeMinutes??1,
    training: score, trainingPassed: passed, holdout: metrics(replayStrategy(symbol, test, config,test.length*2,train,trace(config,true))),
  });yield}
  return {
    symbol, mode: "research-replay", costModel: "net after maker/taker fallback plus fee-relative slippage once", candleExecution: "Observed candle closes only; gaps fill at observed price; no intrabar assumptions",
    trainingCandles: train.length, holdoutCandles: test.length, holdoutStartsAt: new Date(test[0].timestamp).toISOString(),
    configurations: configs.length, enoughSamples: evaluated.filter(x => x.enough).length,
    samplesPercent: configs.length ? 100 * evaluated.filter(x => x.enough).length / configs.length : 0,
    eligible: evaluated.filter(x => x.passed).length, minSamples, minPf, rows,
    executionEligible: false,
    note: "Replay uses the engine's observed-price exits and independent long/short positions. Holdout indicators retain training prehistory, with fresh holdout positions. All closed outcomes are counted. Research does not place orders or qualify Main/Real stages. Returns and drawdown are percentage-point sums, not account equity.",
  }
}
export function runTerminalReplay(symbol:string,candles:MarketCandle[],settings:Record<string,unknown>={}){
  const steps=replaySteps(symbol,candles,settings)
  for(;;){const next=steps.next();if(next.done)return next.value}
}
/** Yield between candidates so research cannot monopolize the trading event loop. */
export async function runTerminalReplayAsync(symbol:string,candles:MarketCandle[],settings:Record<string,unknown>={},signal?:AbortSignal){
  const steps=replaySteps(symbol,candles,settings)
  for(let count=0;;count++){
    signal?.throwIfAborted()
    const next=steps.next();if(next.done)return next.value
    if(count%4===0)await new Promise<void>(resolve=>setImmediate(resolve))
  }
}

/** Run the saved Exec pipeline through the same closed minute bars as the research view. */
export async function runExecProgressionReplay(symbol: string, candles: MarketCandle[], settings: EngineSettings, signal?: AbortSignal) {
  const split = Math.floor(candles.length * .65)
  const holdout = (candles[split].time + 60) * 1000
  const engine = new TradingEngine({ ...settings, symbols: [symbol] })
  const totals = () => ({ closed:0, wins:0, profit:0, loss:0, net:0, cost:0 })
  const books = Object.fromEntries([...STAGES, "executed"].map(stage=>[stage,totals()]))
  const forwarded = new Map(STAGES.filter(stage=>stage!=="live").map(stage=>[stage,totals()]))
  const labels = new Map(EXEC_PROFILES.map(profile=>[profile.id,profile.label]))
  const sourceBooks = new Map<string, {source:string; profile?:string; timeframe:number; period?:number; execCloses:number; open:number; accepted:ReturnType<typeof totals>}>()
  const geometries = new Map<string,NonNullable<ReturnType<typeof sourceBooks.get>>>()
  for (const config of generateEngineCatalog(engine.settings, settings.symbolFees?.[symbol])) {
    const timeframe = config.signalTimeframeMinutes ?? 1
    if (timeframe < 1) continue
    const source = config.indicationSourceId ?? config.type
    const period = config.indicationSourceId ? undefined : config.position_cost_step
    const profile = config.execProfile ? labels.get(config.execProfile) : undefined
    const key = JSON.stringify([source,config.execProfile,timeframe,period])
    let book = sourceBooks.get(key)
    if (!book) {
      book = {source,profile,timeframe,period,execCloses:0,open:0,accepted:totals()}
      sourceBooks.set(key,book)
    }
    geometries.set(config.id,book)
  }
  const sourceBook = (configId:string) => geometries.get(configId.split(".branch2.",1)[0])
  const record = (row: ReturnType<typeof totals>, trade: Readonly<ClosedTrade>) => {
    row.closed++
    row.wins += Number(trade.netReturnPct>0)
    row.profit += Math.max(0,trade.netReturnPct)
    row.loss += Math.max(0,-trade.netReturnPct)
    row.net += trade.netPnl
    row.cost += trade.cost
  }
  const summarize = ({profit,loss,...row}: ReturnType<typeof totals>) => ({...row,...describeProfitFactor(profit,loss,row.closed)})
  engine.observeStageCloses(trade=>{
    if (trade.openedAt < holdout) return
    record(books[trade.stage],trade)
    if (trade.executed) record(books.executed,trade)
    if (trade.stage === "exec") {
      const book = sourceBook(trade.configId)!
      book.execCloses++
      if (trade.executed) record(book.accepted,trade)
    }
    const row = trade.stage === "live" ? undefined : forwarded.get(trade.stage)
    if (row && (trade.progressionProof || trade.executed)) record(row,trade)
  })
  const closedBars = candles.map(bar=>({...bar,timestamp:(bar.time+60)*1000}))
  let batchSize = 8, nextYield = performance.now()+20
  for (let start=0; start<closedBars.length;) {
    signal?.throwIfAborted()
    const batch = closedBars.slice(start,start+batchSize)
    const began = performance.now()
    engine.processCandles(symbol,batch,{eventLimit:0})
    const finished = performance.now()
    start += batch.length
    const msPerBar = Math.max(1,finished-began)/batch.length
    batchSize = Math.max(1,Math.min(64,batchSize*2,Math.floor(10/msPerBar)))
    if (finished>=nextYield) {
      await new Promise<void>(resolve=>setImmediate(resolve))
      nextYield = performance.now()+20
    }
  }
  for (const position of engine.snapshot({laneLimit:0,positionStage:"exec"}).positions) {
    if (position.executed && position.openedAt >= holdout) sourceBook(position.configId)!.open++
  }
  const indications = [...sourceBooks.values()].map(({accepted,...source})=>({...source,...summarize(accepted)}))
    .sort((a,b)=>b.closed-a.closed||b.open-a.open||b.execCloses-a.execCloses||a.source.localeCompare(b.source))
  return ([...STAGES,"executed"] as const).map(stage=>{
    const postStage = stage === "live" || stage === "executed" ? undefined : forwarded.get(stage)
    return {stage,...summarize(books[stage]),...(postStage&&{postStage:summarize(postStage)}),...(stage==="executed"&&{indications})}
  })
}

export type ExecProgressionReplay = Awaited<ReturnType<typeof runExecProgressionReplay>>
