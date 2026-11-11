import { portedStates, StreamMath } from "../shared/cts-indications/index.ts"
import type { Candle, PseudoPosition, SignalState } from "./types"
import { calculatePriceMovePct, POSITION_COST_PCT_DEFAULT } from "./metrics"
import { observedExit } from "./exits"
import { INDICATIONS,TECHNICAL_INDICATIONS } from "./indications"
import {technicalSignal} from './technical-signals'

const sourceStreams=new WeakMap<SignalState,{first:number;stream:StreamMath}>()
export const PORTED_HISTORY_LIMIT=4320
export type SourceContext={symbol:string;peers?:readonly {symbol:string;bars:readonly Candle[]}[]}

export interface ReplayStrategyConfig {
  type: string
  position_cost_step: number
  /** Fraction of entry price, e.g. 0.01 = 1%. Also the trailing activation distance. */
  takeprofit: number
  /** Fraction of price; fixed initial protection and trailing distance. */
  stoploss: number
  trailing: boolean
  exitMode?: "fixed" | "trailing" | "trailing-only"
  /** Percentage points, e.g. 0.176 = 0.176%. Already includes both execution legs. */
  roundTripCostPct?: number
  maxHoldMinutes?: number
  catalogVersion?: number
  trailDistancePct?:number
  indicationSourceId?:string
  signalTimeframeMinutes?:number
}

export interface ReplayPosition extends PseudoPosition {
  exit_reason?: "take_profit" | "stop_loss" | "trailing_stop" | "max_hold"
}

type Direction = "long" | "short"
const TACTICS = new Set<string>(INDICATIONS)

function timestampMs(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : Date.parse(value)
  }
  return Number.NaN
}

export function newSignalState(): SignalState {
  return { count: 0, prices: [], gains: [], losses: [], emaFast: 0, emaSlow: 0, emaSignal: 0, avgGain: 0, avgLoss: 0 }
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
/** Serializable, causal indicator accumulator shared by batch replay and the live engine. */
export function advanceSignal(state: SignalState, price: number, type: string, step: number,bar?:Candle): Direction | undefined {
  if((TECHNICAL_INDICATIONS as readonly string[]).includes(type))return technicalSignal(state,bar??{timestamp:state.count+1,open:price,high:price,low:price,close:price,volume:0},type,step)
  const priorMean = mean(state.prices), priorReady = state.prices.length >= step * 2
  const priorFast=state.emaFast, priorSlow=state.emaSlow
  const priorWidth = 2 * Math.sqrt(mean(state.prices.map(value => (value - priorMean) ** 2)))
  state.prices.push(price)
  if (state.prices.length > step * 2) state.prices.shift()
  const ready = state.prices.length >= step * 2
  const diff = mean(state.prices.slice(-step)) - mean(state.prices)
  if (state.count === 0) state.emaFast = state.emaSlow = price
  else { state.emaFast += 2 / (step + 1) * (price - state.emaFast); state.emaSlow += 2 / (step * 2 + 1) * (price - state.emaSlow) }
  const macd = state.emaFast - state.emaSlow
  state.emaSignal += 2 / (Math.max(2, Math.floor(step / 2)) + 1) * (macd - state.emaSignal)
  const histogram = macd - state.emaSignal
  let rsi: number | undefined
  if (state.previousPrice !== undefined) {
    const change = price - state.previousPrice, gain = Math.max(0, change), loss = Math.max(0, -change)
    if (state.gains.length < step) { state.gains.push(gain); state.losses.push(loss); if (state.gains.length === step) { state.avgGain = mean(state.gains); state.avgLoss = mean(state.losses) } }
    else { state.avgGain = (state.avgGain * (step - 1) + gain) / step; state.avgLoss = (state.avgLoss * (step - 1) + loss) / step }
    if (state.gains.length >= step) rsi = state.avgLoss === 0 ? (state.avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + state.avgGain / state.avgLoss)
  }
  let signal: Direction | undefined
  if (ready && state.previousPrice !== undefined) {
    if ((type === "MA_Cross"||type==="MA_Inverse") && state.previousSmaDiff !== undefined) { if (state.previousSmaDiff <= 0 && diff > 0) signal = type==="MA_Inverse"?"short":"long"; if (state.previousSmaDiff >= 0 && diff < 0) signal = type==="MA_Inverse"?"long":"short" }
    else if (type === "MACD_Signal" && state.previousHistogram !== undefined) { if (state.previousHistogram <= 0 && histogram > 0) signal = "long"; if (state.previousHistogram >= 0 && histogram < 0) signal = "short" }
    else if (type === "RSI_Band" && rsi !== undefined && state.previousRsi !== undefined) { if (state.previousRsi <= 30 && rsi > 30) signal = "long"; if (state.previousRsi >= 70 && rsi < 70) signal = "short" }
    else if (type === "Bollinger_Bounce" && priorReady) {
      if (price >= priorMean - priorWidth && price <= priorMean + priorWidth) { if (state.bandExcursion === "below") signal = "long"; if (state.bandExcursion === "above") signal = "short"; state.bandExcursion = undefined }
      else state.bandExcursion = price < priorMean - priorWidth ? "below" : "above"
    }
    else if(type==="Trend_Pullback"){
      if(state.emaFast>state.emaSlow&&state.emaSlow>priorSlow&&state.previousPrice<=priorFast&&price>state.emaFast)signal="long"
      if(state.emaFast<state.emaSlow&&state.emaSlow<priorSlow&&state.previousPrice>=priorFast&&price<state.emaFast)signal="short"
    }
    else if(type==="RSI_Momentum"&&rsi!==undefined&&state.previousRsi!==undefined){
      if(state.previousRsi<=50&&rsi>50&&state.emaFast>state.emaSlow)signal="long"
      if(state.previousRsi>=50&&rsi<50&&state.emaFast<state.emaSlow)signal="short"
    }
    else if(type==="Bollinger_Breakout"&&priorReady&&priorWidth>0){
      if(state.previousPrice<=priorMean+priorWidth&&price>priorMean+priorWidth&&state.emaFast>state.emaSlow)signal="long"
      if(state.previousPrice>=priorMean-priorWidth&&price<priorMean-priorWidth&&state.emaFast<state.emaSlow)signal="short"
    }
  }
  state.count++; state.previousPrice = price; state.previousSmaDiff = ready ? diff : undefined; state.previousHistogram = ready ? histogram : undefined; state.previousRsi = rsi
  return signal
}
export function createSignalEvaluator(type: string, step: number): (price: number,bar?:Candle) => Direction | undefined {
  const state = newSignalState()
  return (price,bar) => advanceSignal(state, price, type, step,bar)
}

/** Engine timestamps denote closes; only complete, contiguous UTC source candles form a higher bar. */
function configuredClosedBar(state:SignalState,bar:Candle,minutes:number):Candle|undefined{
  if(![1,5,15,30].includes(minutes))throw new Error('Unsupported signal timeframe')
  if(minutes===1)return bar
  const span=minutes*60000,bucket=Math.floor((bar.timestamp-1)/span)*span
  if(!state.frame||state.frame.bucket!==bucket)state.frame={bucket,candle:{...bar},count:1,lastTimestamp:bar.timestamp,complete:bar.timestamp===bucket+60000}
  else{
    const f=state.frame;if(bar.timestamp<=f.lastTimestamp)return
    f.complete&&=bar.timestamp===f.lastTimestamp+60000;f.lastTimestamp=bar.timestamp;f.count++
    f.candle={...f.candle,timestamp:bar.timestamp,high:Math.max(f.candle.high,bar.high),low:Math.min(f.candle.low,bar.low),close:bar.close,volume:f.candle.volume+bar.volume}
  }
  const f=state.frame
  if(bar.timestamp!==bucket+span||!f.complete||f.count!==minutes)return
  return f.candle
}

/** One bounded OHLCV buffer and one shared math cache per symbol/timeframe, independent output per source. */
export function advancePortedSources(state:SignalState,bar:Candle,minutes:number,ids:readonly string[],context:SourceContext={symbol:'ASSET-USDT'}):Map<string,Direction|undefined>{
  const result=new Map<string,Direction|undefined>(),closed=configuredClosedBar(state,bar,minutes)
  if(!closed)return result
  const openTimestamp=closed.timestamp-minutes*60000,rows=state.portedBars??=[]
  if(rows.at(-1)&&openTimestamp<=rows.at(-1)!.timestamp)return result
  rows.push({...closed,timestamp:openTimestamp})
  // Rebase in blocks. Shifting one row per tick would invalidate every incremental indicator cache.
  if(rows.length>PORTED_HISTORY_LIMIT)rows.splice(0,Math.floor(PORTED_HISTORY_LIMIT/2))
  const peers=(context.peers??[]).filter(p=>p.symbol!==context.symbol).map(p=>({symbol:p.symbol,bars:p.bars.filter(b=>b.timestamp<=openTimestamp)}))
  // Reference columns can become available asynchronously. Rebuild their math from this causal prefix.
  let cached=sourceStreams.get(state)
  if(!cached||cached.first!==rows[0].timestamp){cached={first:rows[0].timestamp,stream:new StreamMath()};sourceStreams.set(state,cached)}
  for(const usesReferences of [false,true]){
    const selected=ids.filter(id=>/pair-|market-/.test(id)===usesReferences)
    if(!selected.length)continue
    const output=portedStates(context.symbol,minutes,rows,selected,usesReferences?peers:[],usesReferences?undefined:cached.stream)
    for(const id of selected){const v=output.states[id].at(-1)??0;result.set(id,v>0?'long':v<0?'short':undefined)}
  }
  return result
}
/** Causal historical vectors, segmented at exactly the same bounded-history rebase boundaries as ticks.
 * Reference-dependent sources keep the observation-by-observation path. */
export function historicalPortedSignals(state:SignalState,bars:readonly Candle[],minutes:number,ids:readonly string[],symbol:string):Map<number,Map<string,Direction|undefined>>{
  if(ids.some(id=>/pair-|market-/.test(id)))throw new Error('Reference-dependent sources require observed-prefix evaluation')
  const result=new Map<number,Map<string,Direction|undefined>>(),rows=state.portedBars??=[],pending:{timestamp:number;index:number}[]=[]
  const flush=()=>{
    if(!pending.length)return
    const output=portedStates(symbol,minutes,rows,ids)
    for(const p of pending){const values=new Map<string,Direction|undefined>();for(const id of ids){const v=output.states[id][p.index];values.set(id,v>0?'long':v<0?'short':undefined)}result.set(p.timestamp,values)}
    pending.length=0
  }
  for(const bar of bars){
    const closed=configuredClosedBar(state,bar,minutes);if(!closed)continue
    const timestamp=closed.timestamp-minutes*60000
    if(rows.at(-1)&&timestamp<=rows.at(-1)!.timestamp)continue
    if(rows.length>=PORTED_HISTORY_LIMIT){flush();rows.splice(0,Math.floor(PORTED_HISTORY_LIMIT/2))}
    rows.push({...closed,timestamp});pending.push({timestamp:bar.timestamp,index:rows.length-1})
  }
  flush();sourceStreams.delete(state)
  return result
}
export function advanceConfiguredSignal(state:SignalState,bar:Candle,config:Pick<ReplayStrategyConfig,'type'|'position_cost_step'|'signalTimeframeMinutes'|'indicationSourceId'>,context?:SourceContext):Direction|undefined{
  const minutes=config.signalTimeframeMinutes??1
  if(config.indicationSourceId)return advancePortedSources(state,bar,minutes,[config.indicationSourceId],context).get(config.indicationSourceId)
  const closed=configuredClosedBar(state,bar,minutes)
  if(closed)return advanceSignal(state,closed.close,config.type,config.position_cost_step,closed)
}

function observedBar(row:any,price:number,time:number):Candle{
  const bar={timestamp:time,open:Number(row.open??price),high:Number(row.high??price),low:Number(row.low??price),close:price,volume:Number(row.volume??0)}
  if(![bar.open,bar.high,bar.low,bar.volume].every(Number.isFinite)||bar.open<=0||bar.low<=0||bar.high<Math.max(bar.open,bar.close,bar.low)||bar.low>Math.min(bar.open,bar.close)||bar.volume<0)throw new Error('Invalid observed OHLCV candle')
  return bar
}

/** One causal trace can serve many distance/exit configurations without recomputing indicators. */
export function strategySignalTrace(candles:any[],config:Pick<ReplayStrategyConfig,'type'|'position_cost_step'|'signalTimeframeMinutes'|'indicationSourceId'>,prehistory:any[]=[]):(Direction|undefined)[]{
  const state=newSignalState();let previous=-Infinity
  const observe=(row:any)=>{
    const price=Number(row?.close??row?.price),time=timestampMs(row?.timestamp??row?.time)
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(time)||time<=0||time<=previous)throw new Error('Invalid signal trace candles')
    previous=time;return advanceConfiguredSignal(state,observedBar(row,price,time),config)
  }
  for(const row of prehistory)observe(row)
  return candles.map(observe)
}

/** Last-bar indication, sharing exactly the same causal indicators as replay. */
export function currentStrategySignal(candles: any[], type: string, lookback: number): Direction | null {
  if (!TACTICS.has(type) || !Number.isInteger(lookback) || lookback < 2 || lookback > 10_000) {
    throw new Error("Invalid strategy signal configuration")
  }
  const next = createSignalEvaluator(type, lookback)
  let signal: Direction | undefined
  let previousTime = -Infinity
  for (const row of candles) {
    const price = Number(row?.close ?? row?.price)
    const time = timestampMs(row?.timestamp ?? row?.time)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= 0 || time <= previousTime) {
      throw new Error("Strategy signals require positive observed closes and strictly increasing timestamps")
    }
    previousTime = time
    signal = next(price,observedBar(row,price,time))
  }
  return signal ?? null
}

/**
 * Causal close-only replay. Signals and exits execute at the observed candle
 * close, never the requested TP/SL price or a guessed intrabar path. A gap can
 * therefore fill beyond a stop. New entries cannot exit on their entry candle.
 *
 * MA: fast/slow SMA cross; RSI: Wilder recovery through 30/70; MACD: EMA
 * histogram cross; Bollinger: recovery inside the previous bar's 2σ bands.
 * Indicators use only the current and preceding observations. O(candles) work,
 * O(step + maxPositions) memory. Returned positions are chronological.
 */
export function replayStrategy(
  symbol: string,
  candles: any[],
  config: ReplayStrategyConfig,
  maxPositions = 250,
  prehistory: any[] = [],
  signalTrace?:readonly (Direction|undefined)[],
): PseudoPosition[] {
  if (!TACTICS.has(config.type)) throw new Error(`Unsupported replay tactic: ${config.type}`)
  const step = config.position_cost_step
  if(config.signalTimeframeMinutes!==undefined&&![1,5,15,30].includes(config.signalTimeframeMinutes))throw new Error('Unsupported signal timeframe')
  if (!Number.isInteger(step) || step < 2 || step > 10_000 ||
      !Number.isFinite(config.takeprofit) || config.takeprofit <= 0 ||
      !Number.isFinite(config.stoploss) || config.stoploss <= 0 || config.stoploss >= 1 ||
      !Number.isInteger(maxPositions) || maxPositions < 1) throw new Error("Invalid replay configuration")
  const cost = config.roundTripCostPct ?? POSITION_COST_PCT_DEFAULT
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid round-trip cost")
  if (config.maxHoldMinutes !== undefined && (!Number.isFinite(config.maxHoldMinutes) || config.maxHoldMinutes < 0)) {
    throw new Error("Invalid maximum hold time")
  }
  const mode = config.exitMode ?? (config.trailing ? "trailing" : "fixed")
  if (!["fixed", "trailing", "trailing-only"].includes(mode)) throw new Error("Invalid exit mode")
  const signalState=newSignalState()
  if(signalTrace&&signalTrace.length!==candles.length)throw new Error('Signal trace length does not match candles')
  let previousTime = -Infinity
  for(const row of prehistory){
    const price=Number(row?.close??row?.price), time=timestampMs(row?.timestamp??row?.time)
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(time)||time<=0||time<=previousTime)throw new Error("Invalid replay prehistory")
    previousTime=time;if(!signalTrace)advanceConfiguredSignal(signalState,observedBar(row,price,time),config,{symbol})
  }
  const positions = new Map<Direction,{position:ReplayPosition;entryTime:number;peak:number;trailingActive?:boolean;trailingStopPrice?:number}>()
  const closed: ReplayPosition[] = []
  let closedCount = 0

  for (const [index,row] of candles.entries()) {
    const price = Number(row?.close ?? row?.price)
    const time = timestampMs(row?.timestamp ?? row?.time)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= 0 || time <= previousTime) {
      throw new Error("Replay requires positive observed closes and strictly increasing timestamps")
    }
    previousTime = time
    const candle=observedBar(row,price,time)
    const signal = signalTrace?signalTrace[index]:advanceConfiguredSignal(signalState,candle,config,{symbol})
    if(signal!==undefined&&signal!=='long'&&signal!=='short')throw new Error('Invalid precomputed signal')

    const justClosed=new Set<Direction>()
    for (const [direction,open] of positions) {
      const {position,entryTime}=open
      const grossFraction = calculatePriceMovePct(position.entry_price, price, position.direction ?? "long") / 100
      const exit=observedExit({...open,direction,entryPrice:position.entry_price,peak:open.peak,price,takeProfitPct:config.takeprofit*100,stopLossPct:config.stoploss*100,trailDistancePct:config.trailDistancePct,exitMode:mode,openedAt:entryTime,timestamp:time,maxHoldMinutes:config.maxHoldMinutes??0,trailingBasis:config.catalogVersion!==undefined&&config.catalogVersion<3?"entry":"peak"})
      open.peak=exit.peak;position.stop_loss=exit.stop
      open.trailingActive=exit.trailingActive;open.trailingStopPrice=exit.stop
      if (exit.reason) {
        position.status = "closed"
        position.exit_time = new Date(time).toISOString()
        position.exit_price = price
        position.result = grossFraction * 100 - cost
        position.exit_reason = exit.reason
        closed[closedCount % maxPositions] = position
        closedCount++
        positions.delete(direction);justClosed.add(direction)
      }
    }
    if (signal&&!positions.has(signal)&&!justClosed.has(signal)) {
      const isLong = signal === "long"
      const position:ReplayPosition = {
        entry_time: new Date(time).toISOString(), symbol, entry_price: price,
        take_profit: price * (isLong ? 1 + config.takeprofit : 1 - config.takeprofit),
        stop_loss: price * (isLong ? 1 - config.stoploss : 1 + config.stoploss),
        status: "open", direction: signal, indication_type: config.type,
      }
      positions.set(signal,{position,entryTime:time,peak:price})
    }

  }
  const offset = closedCount >= maxPositions ? closedCount % maxPositions : 0
  const chronological = [...closed.slice(offset), ...closed.slice(0, offset)]
  return [...chronological,...[...positions.values()].map(x=>x.position)].slice(-maxPositions)
}
