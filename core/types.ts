export type Direction = "long" | "short"
export type Stage = "base" | "main" | "real" | "live"
export type Coordination = "normal" | "axis" | "block" | "dca"
export type StrategyRange = "Micro" | "Minimal" | "Short" | "Normal" | "Long" | "Wide"
export type ExitMode = "fixed" | "trailing" | "trailing-only"
export type ProfitFactorState = "empty" | "flat" | "no-losses" | "finite"
export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
export interface StrategyConfig {
  id: string; connectionId: string; createdAt: string; enabled: boolean; catalogVersion?: number
  type: string; position_cost_step: number; takeprofit: number; stoploss: number; trailing: boolean
  range?: StrategyRange; tpStep?: number; slRatio?: number; exitMode?: ExitMode
  roundTripCostPct?: number; maxHoldMinutes?: number
}
export interface PseudoPosition {
  entry_time: string; symbol: string; entry_price: number; take_profit: number; stop_loss: number
  status: "open" | "closed"; result?: number; exit_time?: string; exit_price?: number
  direction?: Direction; indication_type?: string
}
export interface EngineSettings {
  connectionId: string; symbols: string[]; initialEquity: number; baseNotional: number; volumeFactor: number
  stageLastN: { base: number; main: number; real: number }
  stageMinPF: { base: number; main: number; real: number }
  catalog: Record<string, unknown>
  coordinations: {
    axis: { enabled: boolean; previous: number; last: number; outcome: "positive" | "negative" | "any" }
    block: { enabled: boolean; steps: number; ratio: number; mode: "shared" | "additive" }
    dca: { enabled: boolean; steps: number; distancePct: number; multiplier: number }
  }
  /** Retention ceiling; each lane keeps only the samples its stage/Axis windows need. Lifetime metrics are retained separately. */
  maxSamples: number
}
export interface EntryFill { price: number; quantity: number; timestamp: number; kind: "entry" | "block" | "dca" }
export interface PaperPosition {
  id: string; openedAt: number; direction: Direction; fills: EntryFill[]; quantity: number; entryPrice: number
  executionEligible?: boolean
  sizing?: { baseBudget: number; block: EngineSettings["coordinations"]["block"]; dca: EngineSettings["coordinations"]["dca"] }
  peak: number; lastAddPrice: number; addedSteps: number; costPct: number; takeProfitPct: number; stopLossPct: number
  exitMode: ExitMode; maxHoldMinutes: number; notional: number
  trailingBasis?: "peak" | "entry"
}
export interface ClosedTrade {
  id: string; laneId: string; configId: string; symbol: string; direction: Direction; stage: Stage; coordination: Coordination
  openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; quantity: number; notional: number
  grossPnl: number; cost: number; netPnl: number; netReturnPct: number; reason: string; fills: EntryFill[]
  source: "paper"
}
export interface LaneState {
  id: string; symbol: string; configId: string; direction: Direction; stage: Stage; coordination: Coordination
  config: StrategyConfig; samples: number[]; closedCount: number; wins: number; netPnl: number; grossProfit: number; grossLoss: number
  open?: PaperPosition; admittedAt?: number; lastTimestamp: number; admissionCount: number
  costTotal?: number
}
export interface SignalState {
  count: number; prices: number[]; gains: number[]; losses: number[]; previousPrice?: number
  emaFast: number; emaSlow: number; emaSignal: number; avgGain: number; avgLoss: number
  previousSmaDiff?: number; previousHistogram?: number; previousRsi?: number; bandExcursion?: "below" | "above"
}
export interface ExecutionIntent {
  id: string; connectionId: string; laneId: string; configId: string; symbol: string; direction: Direction
  kind: "entry" | "add" | "close"; positionId: string; requestedQuantity: number
  timestamp: number; price: number; notional: number; takeProfitPct: number; stopLossPct: number; exitMode: ExitMode
  source: "real-qualified"; status: "pending" | "acknowledged" | "rejected"
  exchangeOrderId?: string; error?: string
}
export interface EngineEvent { type: "opened" | "added" | "closed" | "qualified" | "execution"; status?:string; reason?:string; laneId: string; timestamp: number; stage: Stage; trade?: ClosedTrade }
export interface EngineState {
  version: 1; settings: EngineSettings; lanes: Record<string, LaneState>; signals: Record<string, SignalState>
  lastTimestamp: Record<string, number>; recentTrades: ClosedTrade[]; intents: ExecutionIntent[]
  recentLiveTrades?: ClosedTrade[]
  processedCandles: number; startedAt: number; updatedAt: number; equity: number; peakEquity: number; maxDrawdownPct: number
  equityHistory: { timestamp: number; equity: number; drawdownPct: number }[]
}
export interface StageMetrics { stage: Stage; lanes: number; open: number; closed: number; enoughSamples: number; enoughSamplesPct: number; qualified: number; profitFactor: number; pfState: ProfitFactorState; netPnl: number; wins:number; fees:number|null; longOpen:number; shortOpen:number; currentLanes:number; currentEnoughSamples:number; currentQualified:number; admissionReady:number; blockedByParent:number; currentProfitFactor:number; currentPfState:ProfitFactorState }
export interface EngineSnapshot {
  settings: EngineSettings; catalogCount: number; symbolCount: number; processedCandles: number; updatedAt: number
  equity: number; peakEquity: number; maxDrawdownPct: number; stages: StageMetrics[]
  positions: (PaperPosition & { laneId: string; symbol: string; configId: string; stage: Stage; coordination: Coordination })[]
  trades: ClosedTrade[]; intents: ExecutionIntent[]; equityHistory: EngineState["equityHistory"]
  liveTrades: ClosedTrade[]
  lanes: { id: string; symbol: string; configId: string; stage: Stage; direction: Direction; coordination: Coordination; count: number; required: number; enoughSamples: boolean; profitFactor: number; pfState: ProfitFactorState; qualified: boolean; netPnl: number }[]
}
