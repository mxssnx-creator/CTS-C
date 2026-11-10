import { createHash } from "node:crypto"
import { generateStrategyCatalog } from "./catalog"
import { advanceSignal, newSignalState } from "./replay"
import { aggregateCostNormalizedResults, describeProfitFactor, POSITION_COST_PCT_DEFAULT } from "./metrics"
import type { Candle, ClosedTrade, Coordination, Direction, EngineEvent, EngineSettings, EngineSnapshot, EngineState, ExecutionIntent, LaneState, PaperPosition, Stage, StrategyConfig } from "./types"

export const STAGES: Stage[] = ["base", "main", "real", "live"]
const OWN_PARSED_STATE = Symbol("engine-owned JSON state")
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  connectionId: "bingx-x02", symbols: ["BTC-USDT", "ETH-USDT", "SOL-USDT"], initialEquity: 10_000,
  baseNotional: 100, volumeFactor: .01, stageLastN: { base: 20, main: 8, real: 8 },
  stageMinPF: { base: 1.1, main: 1.1, real: 1.1 }, maxSamples: 250,
  catalog: { strategyTpSteps: [3, 5, 8, 12, 18, 24, 30], strategySlRatios: [.6, 1, 1.4] },
  coordinations: { axis: { enabled: true, previous: 8, last: 3, outcome: "any" },
    block: { enabled: true, steps: 3, ratio: .2, mode: "shared" },
    dca: { enabled: true, steps: 2, distancePct: 1, multiplier: 2 } },
}
export function normalizeSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase().replace("/", "-").replace("_", "-")
  return /^[A-Z0-9]+USDT$/.test(value) ? `${value.slice(0, -4)}-USDT` : value
}
const finite = (value: number, name: string, min: number, max: number, integer = false) => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}`)
}
export function validateEngineSettings(input: Partial<EngineSettings> = {}): EngineSettings {
  const d = DEFAULT_ENGINE_SETTINGS
  const settings: EngineSettings = {
    ...structuredClone(d), ...input, symbols: (input.symbols ?? d.symbols).map(normalizeSymbol),
    catalog: input.catalog === undefined ? structuredClone(d.catalog) : structuredClone(input.catalog), stageLastN: { ...d.stageLastN, ...input.stageLastN }, stageMinPF: { ...d.stageMinPF, ...input.stageMinPF },
    coordinations: { axis: { ...d.coordinations.axis, ...input.coordinations?.axis }, block: { ...d.coordinations.block, ...input.coordinations?.block }, dca: { ...d.coordinations.dca, ...input.coordinations?.dca } },
  }
  if (!settings.connectionId || settings.symbols.length < 1 || settings.symbols.length > 500 || settings.symbols.some(s => !/^[A-Z0-9]{1,30}-USDT$/.test(s))) throw new Error("Invalid connection or symbols")
  settings.symbols = [...new Set(settings.symbols)]
  finite(settings.initialEquity, "initialEquity", .01, 1e12); finite(settings.baseNotional, "baseNotional", .000001, 1e9)
  finite(settings.volumeFactor, "volumeFactor", .000001, 100); finite(settings.maxSamples, "maxSamples", 1, 1000, true)
  for (const stage of ["base", "main", "real"] as const) { finite(settings.stageLastN[stage], `${stage} lastN`, 1, settings.maxSamples, true); finite(settings.stageMinPF[stage], `${stage} PF`, 0, 999) }
  const { axis, block, dca } = settings.coordinations
  finite(axis.previous, "axis previous", 1, settings.maxSamples, true); finite(axis.last, "axis last", 1, settings.maxSamples, true)
  if (axis.enabled && axis.previous + axis.last > settings.maxSamples) throw new Error("Axis windows exceed retained samples")
  if (!["positive", "negative", "any"].includes(axis.outcome)) throw new Error("Invalid axis outcome")
  finite(block.steps, "block steps", 1, 20, true); finite(block.ratio, "block ratio", .01, 10)
  if (!["shared", "additive"].includes(block.mode)) throw new Error("Invalid block mode")
  finite(dca.steps, "DCA steps", 1, 20, true); finite(dca.distancePct, "DCA distance", .001, 100); finite(dca.multiplier, "DCA multiplier", .01, 10)
  for (const enabled of [axis.enabled, block.enabled, dca.enabled]) if (typeof enabled !== "boolean") throw new Error("Coordination enabled must be boolean")
  generateStrategyCatalog(settings.connectionId, settings.catalog)
  return settings
}
function laneKey(connectionId: string, symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage, identity: string): string {
  // JSON identities cannot collide when a user changes delimiters in a label.
  return JSON.stringify([connectionId, symbol, config.id, direction, coordination, stage, identity])
}
function windowMetrics(lane: LaneState | undefined, required: number, minPF: number) {
  const samples = lane?.samples ?? [], count = Math.min(samples.length, required)
  let profit = 0, loss = 0
  for (let i = 0; i < count; i++) { profit += Math.max(0, samples[i]); loss += Math.max(0, -samples[i]) }
  const pf = describeProfitFactor(profit, loss, count)
  return { count, required, enoughSamples: count >= required, ...pf, qualified: count >= required && pf.profitFactor >= minPF }
}
export class TradingEngine {
  private state: EngineState
  private configs: StrategyConfig[]
  private coordinationIds = {} as Record<Coordination, string>
  private active = new Map<string, Set<string>>()
  private readonly maxRecentTrades = 1000
  /** Parse an independently owned checkpoint without duplicating its entire ledger. */
  static fromSerialized(serialized: string): TradingEngine {
    const restored = JSON.parse(serialized) as EngineState
    if (!restored || typeof restored !== "object") throw new Error("Invalid engine state")
    return new TradingEngine(restored.settings, restored, OWN_PARSED_STATE)
  }
  constructor(settings: Partial<EngineSettings> = {}, restored?: EngineState, ownership?: symbol) {
    const validated = validateEngineSettings({ ...restored?.settings, ...settings })
    if (restored && restored.version !== 1) throw new Error("Unsupported engine state")
    if (restored && restored.settings.connectionId !== validated.connectionId) throw new Error("Restored engine belongs to another connection")
    this.state = restored ? ownership === OWN_PARSED_STATE ? restored : structuredClone(restored) : {
      version: 1, settings: validated, lanes: {}, signals: {}, lastTimestamp: {}, recentTrades: [], intents: [], processedCandles: 0,
      startedAt: Date.now(), updatedAt: 0, equity: validated.initialEquity, peakEquity: validated.initialEquity, maxDrawdownPct: 0, equityHistory: [],
    }
    this.state.settings = validated
    this.configs = generateStrategyCatalog(validated.connectionId, validated.catalog, "1970-01-01T00:00:00.000Z")
    this.refreshCoordinationIds()
    for (const lane of Object.values(this.state.lanes)) {
      lane.samples.length = Math.min(lane.samples.length, this.sampleRetention(lane))
      if (lane.open) this.activate(lane)
    }
  }
  get settings(): EngineSettings { return structuredClone(this.state.settings) }
  lastProcessedAt(symbol: string): number | null { return this.state.lastTimestamp[normalizeSymbol(symbol)] ?? null }
  updateSettings(input: Partial<EngineSettings>): void {
    const previous = this.state.settings
    if (input.connectionId && input.connectionId !== previous.connectionId) throw new Error("Use a separate engine for another connection")
    this.state.settings = validateEngineSettings({ ...previous, ...input,
      stageLastN: { ...previous.stageLastN, ...input.stageLastN }, stageMinPF: { ...previous.stageMinPF, ...input.stageMinPF },
      coordinations: { axis: { ...previous.coordinations.axis, ...input.coordinations?.axis }, block: { ...previous.coordinations.block, ...input.coordinations?.block }, dca: { ...previous.coordinations.dca, ...input.coordinations?.dca } },
    })
    this.configs = generateStrategyCatalog(this.state.settings.connectionId, this.state.settings.catalog, "1970-01-01T00:00:00.000Z")
    this.refreshCoordinationIds()
    for (const lane of Object.values(this.state.lanes)) lane.samples.length = Math.min(lane.samples.length, this.sampleRetention(lane))
  }
  exportState(): EngineState { return structuredClone(this.state) }
  serializeState(): string { return JSON.stringify(this.state) }
  private activate(lane: LaneState) {
    if (!this.active.has(lane.symbol)) this.active.set(lane.symbol, new Set())
    this.active.get(lane.symbol)!.add(lane.id)
  }
  private refreshCoordinationIds(): void {
    const s = this.state.settings
    for (const coordination of ["normal", "axis", "block", "dca"] as const) {
      const parameters = coordination === "normal" ? null : s.coordinations[coordination]
      this.coordinationIds[coordination] = hashId(JSON.stringify([s.baseNotional, s.volumeFactor, parameters, s.stageLastN, s.stageMinPF]))
    }
  }
  private coordinationIdentity(coordination: Coordination): string { return this.coordinationIds[coordination] }
  /** maxSamples is a ceiling, not a target allocation. Lifetime totals are separate. */
  private sampleRetention(lane: Pick<LaneState, "stage" | "coordination">): number {
    const s = this.state.settings
    const gateWindow = s.stageLastN[lane.stage === "live" ? "real" : lane.stage]
    const axisWindow = lane.coordination === "normal" && s.coordinations.axis.enabled
      ? s.coordinations.axis.previous + s.coordinations.axis.last : 0
    return Math.min(s.maxSamples, Math.max(gateWindow, axisWindow))
  }
  private lane(symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage): LaneState {
    const id = laneKey(this.state.settings.connectionId, symbol, config, direction, coordination, stage, this.coordinationIdentity(coordination))
    if (!this.state.lanes[id]) {
      this.state.lanes[id] = { id, symbol, configId: config.id, direction, coordination, stage, config: { ...config }, samples: [], closedCount: 0, wins: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, lastTimestamp: 0, admissionCount: 0 }
    }
    return this.state.lanes[id]
  }
  private hasParentEvidence(symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage): boolean {
    if (stage === "base") return true
    const parent = STAGES[STAGES.indexOf(stage) - 1] as "base" | "main" | "real"
    const lane = this.state.lanes[laneKey(this.state.settings.connectionId, symbol, config, direction, coordination, parent, this.coordinationIdentity(coordination))]
    const s = this.state.settings
    return windowMetrics(lane, s.stageLastN[parent], s.stageMinPF[parent]).qualified
  }
  private axisAllows(symbol: string, config: StrategyConfig, direction: Direction, stage: Stage): boolean {
    const s = this.state.settings, axis = s.coordinations.axis
    const source = this.state.lanes[laneKey(s.connectionId, symbol, config, direction, "normal", stage, this.coordinationIdentity("normal"))]
    if (!source || source.samples.length < axis.previous + axis.last) return false
    const previousPF = aggregateCostNormalizedResults(source.samples.slice(axis.last, axis.last + axis.previous)).profitFactor
    const lastNet = source.samples.slice(0, axis.last).reduce((a, b) => a + b, 0)
    const threshold = stage === "live" ? s.stageMinPF.real : s.stageMinPF[stage]
    return previousPF >= threshold && (axis.outcome === "any" || (axis.outcome === "positive" ? lastNet > 0 : lastNet < 0))
  }
  private open(lane: LaneState, candle: Candle): PaperPosition {
    const s = this.state.settings, block = s.coordinations.block
    const total = s.baseNotional * s.volumeFactor
    const notional = lane.coordination === "block" && block.mode === "shared" ? total / (1 + block.steps * block.ratio) : total
    const quantity = notional / candle.close
    const position: PaperPosition = {
      id: `${lane.id}@${candle.timestamp}`, openedAt: candle.timestamp, direction: lane.direction,
      fills: [{ price: candle.close, quantity, timestamp: candle.timestamp, kind: "entry" }], quantity,
      sizing: { baseBudget: total, block: structuredClone(s.coordinations.block), dca: structuredClone(s.coordinations.dca) },
      entryPrice: candle.close, peak: candle.close, lastAddPrice: candle.close, addedSteps: 0,
      costPct: lane.config.roundTripCostPct ?? POSITION_COST_PCT_DEFAULT,
      takeProfitPct: lane.config.takeprofit * 100, stopLossPct: lane.config.stoploss * 100,
      exitMode: lane.config.exitMode ?? (lane.config.trailing ? "trailing" : "fixed"), maxHoldMinutes: lane.config.maxHoldMinutes ?? 240, notional,
    }
    lane.open = position; lane.lastTimestamp = candle.timestamp; lane.admittedAt ??= candle.timestamp; lane.admissionCount++
    this.activate(lane)
    return position
  }
  private close(lane: LaneState, candle: Candle, reason: string): ClosedTrade {
    const open = lane.open!, sign = lane.direction === "long" ? 1 : -1
    const grossPnl = sign * (candle.close - open.entryPrice) * open.quantity
    // Expected fees+slippage at recorded entry notional. Exchange settlements remain separate.
    const cost = open.notional * open.costPct / 100, netPnl = grossPnl - cost
    const netReturnPct = netPnl / open.notional * 100
    const trade: ClosedTrade = { id: open.id, laneId: lane.id, configId: lane.configId, symbol: lane.symbol, direction: lane.direction, stage: lane.stage, coordination: lane.coordination,
      openedAt: open.openedAt, closedAt: candle.timestamp, entryPrice: open.entryPrice, exitPrice: candle.close,
      quantity: open.quantity, notional: open.notional, grossPnl, cost, netPnl, netReturnPct, reason, fills: structuredClone(open.fills), source: "paper" }
    lane.samples.unshift(netReturnPct); lane.samples.length = Math.min(lane.samples.length, this.sampleRetention(lane))
    lane.closedCount++; lane.wins += netPnl > 0 ? 1 : 0; lane.netPnl += netPnl
    lane.grossProfit += Math.max(0, netReturnPct); lane.grossLoss += Math.max(0, -netReturnPct)
    lane.open = undefined; this.active.get(lane.symbol)?.delete(lane.id)
    this.state.recentTrades.unshift(trade); this.state.recentTrades.length = Math.min(this.state.recentTrades.length, this.maxRecentTrades)
    if (lane.stage === "live") {
      this.state.equity += netPnl; this.state.peakEquity = Math.max(this.state.peakEquity, this.state.equity)
      const dd = this.state.peakEquity > 0 ? 100 * (this.state.peakEquity - this.state.equity) / this.state.peakEquity : 0
      this.state.maxDrawdownPct = Math.max(this.state.maxDrawdownPct, dd)
      this.state.equityHistory.push({ timestamp: candle.timestamp, equity: this.state.equity, drawdownPct: dd })
      if (this.state.equityHistory.length > 1000) this.state.equityHistory.shift()
    }
    return trade
  }
  private mark(lane: LaneState, candle: Candle): EngineEvent | undefined {
    const open = lane.open
    if (!open || candle.timestamp <= Math.max(open.openedAt, lane.lastTimestamp)) return
    lane.lastTimestamp = candle.timestamp
    const sign = lane.direction === "long" ? 1 : -1
    open.peak = lane.direction === "long" ? Math.max(open.peak, candle.close) : Math.min(open.peak, candle.close)
    const move = sign * (candle.close - open.entryPrice) / open.entryPrice * 100
    const peakMove = sign * (open.peak - open.entryPrice) / open.entryPrice * 100
    const fromPeak = sign * (open.peak - candle.close) / open.entryPrice * 100
    const trailActive = open.exitMode === "trailing-only" || (open.exitMode === "trailing" && peakMove >= open.takeProfitPct)
    const reason = move <= -open.stopLossPct ? "stop_loss"
      : open.exitMode === "fixed" && move >= open.takeProfitPct ? "take_profit"
      : trailActive && fromPeak >= open.stopLossPct ? "trailing_stop"
      : candle.timestamp - open.openedAt >= open.maxHoldMinutes * 60_000 ? "max_hold" : undefined
    if (reason) return { type: "closed", laneId: lane.id, timestamp: candle.timestamp, stage: lane.stage, trade: this.close(lane, candle, reason) }
    const s = this.state.settings
    const sizing = open.sizing ?? { baseBudget: s.baseNotional * s.volumeFactor, block: s.coordinations.block, dca: s.coordinations.dca }
    let addNotional = 0, kind: "block" | "dca" = "block"
    if (lane.coordination === "block" && open.addedSteps < sizing.block.steps) {
      const fromLast = sign * (candle.close - open.lastAddPrice) / open.lastAddPrice * 100
      if (fromLast >= open.takeProfitPct / (sizing.block.steps + 1)) {
        const b = sizing.block
        addNotional = sizing.baseBudget * b.ratio / (b.mode === "shared" ? 1 + b.steps * b.ratio : 1)
      }
    }
    if (lane.coordination === "dca" && open.addedSteps < sizing.dca.steps) {
      const adverse = -sign * (candle.close - open.lastAddPrice) / open.lastAddPrice * 100
      if (adverse >= sizing.dca.distancePct) { addNotional = sizing.baseBudget * sizing.dca.multiplier; kind = "dca" }
    }
    if (addNotional > 0) {
      const quantity = addNotional / candle.close
      open.fills.push({ price: candle.close, quantity, timestamp: candle.timestamp, kind })
      open.notional += addNotional; open.quantity += quantity; open.entryPrice = open.notional / open.quantity
      open.lastAddPrice = candle.close; open.addedSteps++
      return { type: "added", laneId: lane.id, timestamp: candle.timestamp, stage: lane.stage }
    }
  }
  private enqueueIntent(lane: LaneState, position: PaperPosition, candle: Candle, kind: "entry" | "add" | "close", requestedQuantity: number): void {
    const id = `ctsc_${hashId(`${position.id}:${kind}:${candle.timestamp}:${position.addedSteps}`)}`
    if (this.state.intents.some(intent => intent.id === id)) return
    this.state.intents.push({ id, kind, positionId: position.id, requestedQuantity,
      connectionId: this.state.settings.connectionId, laneId: lane.id, configId: lane.configId, symbol: lane.symbol, direction: lane.direction,
      timestamp: candle.timestamp, price: candle.close, notional: requestedQuantity * candle.close,
      takeProfitPct: position.takeProfitPct, stopLossPct: position.stopLossPct, exitMode: position.exitMode, source: "real-qualified", status: "pending" })
  }
  processCandles(symbolInput: string, candles: Candle[], options: { allowExecution?: boolean } = {}): EngineEvent[] {
    const symbol = normalizeSymbol(symbolInput), s = this.state.settings
    if (!s.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is not configured`)
    const events: EngineEvent[] = []
    let inputTimestamp = -Infinity
    // Validate the complete batch before any mutation, so rejected input is atomic.
    for (const candle of candles) {
      if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
        || candle.timestamp <= 0 || candle.close <= 0 || candle.open <= 0 || candle.low <= 0 || candle.high < Math.max(candle.open, candle.close, candle.low)
        || candle.low > Math.min(candle.open, candle.close) || candle.volume < 0 || candle.timestamp <= inputTimestamp) throw new Error("Invalid or unsorted observed candles")
      inputTimestamp = candle.timestamp
    }
    for (const candle of candles) {
      if (candle.timestamp <= (this.state.lastTimestamp[symbol] ?? 0)) continue
      const justClosed = new Set<string>()
      for (const id of [...(this.active.get(symbol) ?? [])]) {
        const lane = this.state.lanes[id], position = lane.open!
        const event = this.mark(lane, candle)
        if (event) {
          events.push(event)
          if (event.type === "closed") justClosed.add(id)
          if (lane.stage === "live" && position.executionEligible) {
            if (event.type === "closed") this.enqueueIntent(lane, position, candle, "close", position.quantity)
            if (event.type === "added") this.enqueueIntent(lane, position, candle, "add", position.fills.at(-1)!.quantity)
          }
        }
      }
      const signals = new Map<string, Direction | undefined>()
      for (const config of this.configs) {
        const key = JSON.stringify([symbol, config.type, config.position_cost_step])
        if (!signals.has(key)) {
          const state = this.state.signals[key] ??= newSignalState()
          signals.set(key, advanceSignal(state, candle.close, config.type, config.position_cost_step))
        }
      }
      for (const config of this.configs) {
        const signal = signals.get(JSON.stringify([symbol, config.type, config.position_cost_step]))
        if (!signal) continue
        const coordinations: Coordination[] = ["normal"]
        if (s.coordinations.axis.enabled) coordinations.push("axis")
        if (s.coordinations.block.enabled) coordinations.push("block")
        if (s.coordinations.dca.enabled) coordinations.push("dca")
        for (const coordination of coordinations) for (const stage of STAGES) {
          if (!this.hasParentEvidence(symbol, config, signal, coordination, stage)) continue
          if (coordination === "axis" && !this.axisAllows(symbol, config, signal, stage)) continue
          const lane = this.lane(symbol, config, signal, coordination, stage)
          if (lane.open || justClosed.has(lane.id)) continue
          const position = this.open(lane, candle)
          events.push({ type: "opened", laneId: lane.id, timestamp: candle.timestamp, stage })
          if (stage === "live" && options.allowExecution) {
            position.executionEligible = true
            this.enqueueIntent(lane, position, candle, "entry", position.quantity)
          }
        }
      }
      this.state.lastTimestamp[symbol] = candle.timestamp; this.state.updatedAt = Math.max(this.state.updatedAt, candle.timestamp); this.state.processedCandles++
    }
    return events
  }
  /** Manage existing positions on observed quote ticks; signals remain closed-bar only. */
  processTick(symbolInput: string, price: number, timestamp: number): EngineEvent[] {
    const symbol = normalizeSymbol(symbolInput)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Invalid observed quote")
    const candle: Candle = { timestamp, open: price, high: price, low: price, close: price, volume: 0 }
    const events: EngineEvent[] = []
    for (const id of [...(this.active.get(symbol) ?? [])]) {
      const lane = this.state.lanes[id], position = lane.open!
      const event = this.mark(lane, candle)
      if (!event) continue
      events.push(event)
      if (lane.stage === "live" && position.executionEligible) {
        if (event.type === "closed") this.enqueueIntent(lane, position, candle, "close", position.quantity)
        if (event.type === "added") this.enqueueIntent(lane, position, candle, "add", position.fills.at(-1)!.quantity)
      }
    }
    this.state.updatedAt = Math.max(this.state.updatedAt, timestamp)
    return events
  }
  pendingIntents(): ExecutionIntent[] { return structuredClone(this.state.intents.filter(i => i.status === "pending")) }
  markExecution(id: string, result: { status: "acknowledged" | "rejected"; exchangeOrderId?: string; error?: string }): void {
    const intent = this.state.intents.find(i => i.id === id)
    if (!intent) throw new Error("Execution intent not found")
    if (intent.status !== "pending") return
    Object.assign(intent, result)
    const settled = this.state.intents.filter(i => i.status !== "pending")
    if (settled.length > 1000) { const remove = new Set(settled.slice(0, settled.length - 1000).map(i => i.id)); this.state.intents = this.state.intents.filter(i => !remove.has(i.id)) }
  }
  activePositionIds(): Set<string> {
    const ids = new Set<string>()
    for (const lanes of this.active.values()) for (const id of lanes) {
      const position = this.state.lanes[id].open
      if (position) ids.add(position.id)
    }
    return ids
  }
  hasOpenPositions(): boolean { return [...this.active.values()].some(lanes => lanes.size > 0) }
  snapshot(options: { laneLimit?: number; positionLimit?: number; positionStage?: Stage } = {}): EngineSnapshot {
    const laneLimit = options.laneLimit ?? Infinity, positionLimit = options.positionLimit ?? Infinity
    for (const limit of [laneLimit, positionLimit]) if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new Error("Invalid snapshot limit")
    const s = this.state.settings
    const lanes: EngineSnapshot["lanes"] = [], positions: EngineSnapshot["positions"] = []
    const stageStats = Object.fromEntries(STAGES.map(stage => [stage, { stage, lanes: 0, open: 0, closed: 0, enoughSamples: 0, enoughSamplesPct: 0, qualified: 0, profitFactor: 1, netPnl: 0, profit: 0, loss: 0 }])) as Record<Stage, { stage: Stage; lanes: number; open: number; closed: number; enoughSamples: number; enoughSamplesPct: number; qualified: number; profitFactor: number; netPnl: number; profit: number; loss: number }>
    for (const lane of Object.values(this.state.lanes)) {
      const source = lane.stage === "live" ? "real" : lane.stage
      const metrics = windowMetrics(lane, s.stageLastN[source], s.stageMinPF[source])
      const stats = stageStats[lane.stage]
      stats.lanes++; stats.open += lane.open ? 1 : 0; stats.closed += lane.closedCount
      stats.enoughSamples += metrics.enoughSamples ? 1 : 0; stats.qualified += metrics.qualified ? 1 : 0
      stats.profit += lane.grossProfit; stats.loss += lane.grossLoss; stats.netPnl += lane.netPnl
      if (lanes.length < laneLimit) lanes.push({ id: lane.id, symbol: lane.symbol, configId: lane.configId, stage: lane.stage, direction: lane.direction, coordination: lane.coordination, ...metrics, netPnl: lane.netPnl })
      if (lane.open && (!options.positionStage || options.positionStage === lane.stage) && positions.length < positionLimit) positions.push({ ...lane.open, laneId: lane.id, symbol: lane.symbol, configId: lane.configId, stage: lane.stage, coordination: lane.coordination })
    }
    const stages = STAGES.map(stage => {
      const { profit, loss, ...stats } = stageStats[stage]
      stats.enoughSamplesPct = stats.lanes ? 100 * stats.enoughSamples / stats.lanes : 0
      return { ...stats, ...describeProfitFactor(profit, loss, stats.closed) }
    })
    return structuredClone({ settings: s, catalogCount: this.configs.length, symbolCount: s.symbols.length, processedCandles: this.state.processedCandles, updatedAt: this.state.updatedAt,
      equity: this.state.equity, peakEquity: this.state.peakEquity, maxDrawdownPct: this.state.maxDrawdownPct, stages,
      positions, trades: this.state.recentTrades, intents: this.state.intents, equityHistory: this.state.equityHistory, lanes })
  }
}
// Deterministic client IDs survive restart and retries; credentials are never inputs.
function hashId(text: string): string { return createHash("sha256").update(text).digest("hex").slice(0, 32) }
