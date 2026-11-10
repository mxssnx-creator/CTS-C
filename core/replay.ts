import type { PseudoPosition, SignalState } from "./types"
import { calculatePriceMovePct, POSITION_COST_PCT_DEFAULT } from "./metrics"

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
}

export interface ReplayPosition extends PseudoPosition {
  exit_reason?: "take_profit" | "stop_loss" | "trailing_stop" | "max_hold"
}

type Direction = "long" | "short"
const TACTICS = new Set(["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"])

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
export function advanceSignal(state: SignalState, price: number, type: string, step: number): Direction | undefined {
  const priorMean = mean(state.prices), priorReady = state.prices.length >= step * 2
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
    if (type === "MA_Cross" && state.previousSmaDiff !== undefined) { if (state.previousSmaDiff <= 0 && diff > 0) signal = "long"; if (state.previousSmaDiff >= 0 && diff < 0) signal = "short" }
    else if (type === "MACD_Signal" && state.previousHistogram !== undefined) { if (state.previousHistogram <= 0 && histogram > 0) signal = "long"; if (state.previousHistogram >= 0 && histogram < 0) signal = "short" }
    else if (type === "RSI_Band" && rsi !== undefined && state.previousRsi !== undefined) { if (state.previousRsi <= 30 && rsi > 30) signal = "long"; if (state.previousRsi >= 70 && rsi < 70) signal = "short" }
    else if (type === "Bollinger_Bounce" && priorReady) {
      if (price >= priorMean - priorWidth && price <= priorMean + priorWidth) { if (state.bandExcursion === "below") signal = "long"; if (state.bandExcursion === "above") signal = "short"; state.bandExcursion = undefined }
      else state.bandExcursion = price < priorMean - priorWidth ? "below" : "above"
    }
  }
  state.count++; state.previousPrice = price; state.previousSmaDiff = ready ? diff : undefined; state.previousHistogram = ready ? histogram : undefined; state.previousRsi = rsi
  return signal
}
export function createSignalEvaluator(type: string, step: number): (price: number) => Direction | undefined {
  const state = newSignalState()
  return price => advanceSignal(state, price, type, step)
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
    signal = next(price)
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
): PseudoPosition[] {
  if (!TACTICS.has(config.type)) throw new Error(`Unsupported replay tactic: ${config.type}`)
  const step = config.position_cost_step
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
  const nextSignal = createSignalEvaluator(config.type, step)
  let previousTime = -Infinity
  let position: ReplayPosition | undefined
  let entryTime = 0
  let favorablePrice = 0
  let trailingActive = false
  const closed: ReplayPosition[] = []
  let closedCount = 0

  for (const row of candles) {
    const price = Number(row?.close ?? row?.price)
    const time = timestampMs(row?.timestamp ?? row?.time)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= 0 || time <= previousTime) {
      throw new Error("Replay requires positive observed closes and strictly increasing timestamps")
    }
    previousTime = time
    const signal = nextSignal(price)

    if (position) {
      const isLong = position.direction === "long"
      const grossFraction = calculatePriceMovePct(position.entry_price, price, position.direction ?? "long") / 100
      if (isLong) favorablePrice = Math.max(favorablePrice, price)
      else favorablePrice = Math.min(favorablePrice, price)
      if (mode !== "fixed" && (mode === "trailing-only" || grossFraction >= config.takeprofit)) trailingActive = true
      if (trailingActive) {
        const proposed = favorablePrice * (isLong ? 1 - config.stoploss : 1 + config.stoploss)
        position.stop_loss = isLong ? Math.max(position.stop_loss, proposed) : Math.min(position.stop_loss, proposed)
      }
      const hitStop = isLong ? price <= position.stop_loss : price >= position.stop_loss
      const hitTp = mode === "fixed" && grossFraction >= config.takeprofit
      const timedOut = !!config.maxHoldMinutes && time - entryTime >= config.maxHoldMinutes * 60_000
      if (hitStop || hitTp || timedOut) {
        position.status = "closed"
        position.exit_time = new Date(time).toISOString()
        position.exit_price = price
        position.result = grossFraction * 100 - cost
        position.exit_reason = hitStop ? (trailingActive ? "trailing_stop" : "stop_loss") : hitTp ? "take_profit" : "max_hold"
        closed[closedCount % maxPositions] = position
        closedCount++
        position = undefined
      }
    } else if (signal) {
      const isLong = signal === "long"
      position = {
        entry_time: new Date(time).toISOString(), symbol, entry_price: price,
        take_profit: price * (isLong ? 1 + config.takeprofit : 1 - config.takeprofit),
        stop_loss: price * (isLong ? 1 - config.stoploss : 1 + config.stoploss),
        status: "open", direction: signal, indication_type: config.type,
      }
      entryTime = time
      favorablePrice = price
      trailingActive = mode === "trailing-only"
    }

  }
  const offset = closedCount >= maxPositions ? closedCount % maxPositions : 0
  const chronological = [...closed.slice(offset), ...closed.slice(0, offset)]
  return position ? [...chronological, position].slice(-maxPositions) : chronological
}
