import { generateStrategyCatalog, STRATEGY_RANGES } from "./catalog"
import { replayStrategy,strategySignalTrace } from "./replay"
import { aggregateCostNormalizedResults } from "./metrics"
import type { MarketCandle } from "./market"
import type { StrategyConfig, PseudoPosition } from "./types"

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
  if (candles.length < 100 || candles.length > 20000) throw new Error("Replay needs 100..20000 chronological candles")
  const split = Math.floor(candles.length * .65)
  const barSeconds=Number(settings.replayBarSeconds??0)
  if(!Number.isFinite(barSeconds)||barSeconds<0)throw new Error("Invalid replay interval")
  const train = candles.slice(0, split).map(c => ({ ...c, timestamp: (c.time+barSeconds) * 1000 }))
  const test = candles.slice(split).map(c => ({ ...c, timestamp: (c.time+barSeconds) * 1000 }))
  const configs = generateStrategyCatalog("terminal-research", settings)
  const minSamples = Math.max(1, Math.min(200, Number(settings.mainEvalPosCount) || 8))
  const minPf = Math.max(1, Number(settings.baseProfitFactor) || 1.05)
  const evaluated = [] as {config:StrategyConfig;score:ReturnType<typeof metrics>;enough:boolean;passed:boolean}[]
  const trainTraces=new Map<string,ReturnType<typeof strategySignalTrace>>(),testTraces=new Map<string,ReturnType<typeof strategySignalTrace>>()
  const trace=(config:StrategyConfig,holdout=false)=>{
    const key=JSON.stringify([config.type,config.position_cost_step,config.signalTimeframeMinutes??1]),cache=holdout?testTraces:trainTraces
    let value=cache.get(key)
    if(!value){value=strategySignalTrace(holdout?test:train,config,holdout?train:[]);cache.set(key,value)}return value
  }
  for(const config of configs){
    const score = metrics(replayStrategy(symbol, train, config,train.length*2,[],trace(config)))
    evaluated.push({ config, score, enough: score.trades >= minSamples, passed: score.trades >= minSamples && (score.pf ?? 0) >= minPf })
    yield
  }
  const selected: typeof evaluated = []
  for (const range of STRATEGY_RANGES) {
    const candidates = evaluated.filter(v => v.config.range === range).sort((a, b) => Number(b.passed) - Number(a.passed) || Number(b.enough) - Number(a.enough) || (b.score.pf ?? -1) - (a.score.pf ?? -1) || b.score.netReturnSumPct - a.score.netReturnSumPct || a.config.id.localeCompare(b.config.id))
    selected.push(...candidates.slice(0, 3))
  }
  const rows=[] as {id:string;range:StrategyConfig['range'];tactic:string;tpStep:StrategyConfig['tpStep'];slRatio:StrategyConfig['slRatio'];exitMode:StrategyConfig['exitMode'];lookback:number;signalTimeframeMinutes:number;training:ReturnType<typeof metrics>;trainingPassed:boolean;holdout:ReturnType<typeof metrics>}[]
  for(const {config,score,passed} of selected){rows.push({
    id: config.id, range: config.range, tactic: config.type, tpStep: config.tpStep, slRatio: config.slRatio, exitMode: config.exitMode,lookback:config.position_cost_step,signalTimeframeMinutes:config.signalTimeframeMinutes??1,
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
