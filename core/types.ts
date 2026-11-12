import type {BlockPolicy} from "../shared/cts-lastn/blocks.ts";
export type Direction = "long" | "short"
export type Stage = "base" | "main" | "real" | "live"
export type Coordination = "normal" | "axis" | "block" | "dca"
export type StrategyRange = "Micro" | "Minimal" | "Short" | "Normal" | "Long" | "Wide" | "Low-Range"
export type ExitMode = "fixed" | "trailing" | "trailing-only"
export type ProfitFactorState = "empty" | "flat" | "no-losses" | "finite"
export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
export interface StrategyConfig {
  id: string; connectionId: string; createdAt: string; enabled: boolean; catalogVersion?: number
  type: string; position_cost_step: number; takeprofit: number; stoploss: number; trailing: boolean
  range?: StrategyRange; tpStep?: number; slRatio?: number; exitMode?: ExitMode
  roundTripCostPct?: number; maxHoldMinutes?: number; trailDistancePct?:number
  indicationSourceId?:string
  autoPfFloor?:number
  /** Maximum peak-to-trough sum of net-return percentage points in this lane's gate window. Not account drawdown. */
  maxWindowDrawdownPct?:number
  signalTimeframeMinutes?:number
}
export interface PseudoPosition {
  entry_time: string; symbol: string; entry_price: number; take_profit: number; stop_loss: number
  status: "open" | "closed"; result?: number; exit_time?: string; exit_price?: number
  direction?: Direction; indication_type?: string
}
export interface EngineSettings {
  stageBlocks?: Partial<Record<"base"|"main"|"real",BlockPolicy>>;
  liveEntryMode?:'independent'|'real-mirror'
  stageGateMode?:'continuous-ancestors'|'processed-sets'
  connectionId: string; symbols: string[]; initialEquity: number; baseNotional: number; volumeFactor: number
  volumeRatios?:Record<Coordination,number>
  maxOrderNotional?:number
  symbolFees?:Record<string,{makerFeePct:number;takerFeePct:number}>
  stageLastN: { base: number; main: number; real: number }
  stageMinPF: { base: number; main: number; real: number }
  catalog: Record<string, unknown>
  coordinations: {
    axis: { enabled: boolean; previous: number; last: number; outcome: "positive" | "negative" | "any";reference?:'base'|'same-stage' }
    block: { enabled: boolean; steps: number; ratio: number; mode: "shared" | "additive"; behavior?: "pyramid" | "rounds"; size?:number; pauseRounds?:number; maxMultiplier?:number }
    dca: { enabled: boolean; steps: number; distancePct: number; multiplier: number }
  }
  /** Retention ceiling; each lane keeps only the samples its stage/Axis windows need. Lifetime metrics are retained separately. */
  maxSamples: number
}
export interface EntryFill { price: number; quantity: number; timestamp: number; kind: "entry" | "block" | "dca" }
export interface GateProof {stage:Stage;laneId:string;count:number;required:number;minPF:number;profitFactor:number;pfState:ProfitFactorState;qualified:boolean;checkedAt:number;blockPolicyKey?:string;drawdownPct?:number;maxDrawdownPct?:number}
export interface PaperPosition {
  id: string; openedAt: number; direction: Direction; fills: EntryFill[]; quantity: number; entryPrice: number
  activationOrder?:number
  executionEligible?: boolean
  parentPositionId?:string
  admission?:GateProof[]
  sizing?: { baseBudget: number; block: EngineSettings["coordinations"]["block"]; dca: EngineSettings["coordinations"]["dca"] }
  peak: number; lastAddPrice: number; addedSteps: number; costPct: number; takeProfitPct: number; stopLossPct: number
  exitMode: ExitMode; maxHoldMinutes: number; notional: number
  trailingBasis?: "peak" | "entry"
  trailDistancePct?:number;trailingActive?:boolean;trailingStopPrice?:number;exitPolicyVersion?:number;maxOrderNotional?:number
}
export interface ClosedTrade {
  id: string; laneId: string; configId: string; symbol: string; direction: Direction; stage: Stage; coordination: Coordination
  openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; quantity: number; notional: number
  grossPnl: number; cost: number; netPnl: number; netReturnPct: number; reason: string; fills: EntryFill[]
  source: "paper"
  admission?:GateProof[]
  parentPositionId?:string
}
export interface LaneState {
  /** Internal Normal reference, never funded or counted as active Live execution. */
  calculationOnly?: boolean;
  blockRound?: { closed:number; sum:number; net:number; level:number; pauseRemaining:number; rounds:number };
  id: string; symbol: string; configId: string; direction: Direction; stage: Stage; coordination: Coordination
  config: StrategyConfig; samples: number[]; closedCount: number; wins: number; netPnl: number; grossProfit: number; grossLoss: number
  open?: PaperPosition; admittedAt?: number; lastTimestamp: number; admissionCount: number
  costTotal?: number
  admittedClosed?:number;admittedProfit?:number;admittedLoss?:number;admittedNetPnl?:number
  parentProof?:GateProof[]
}
export interface SignalState {
  portedBars?: Candle[];
  lastSourceTimestamp?:number;
  count: number; prices: number[]; gains: number[]; losses: number[]; previousPrice?: number
  emaFast: number; emaSlow: number; emaSignal: number; avgGain: number; avgLoss: number
  previousSmaDiff?: number; previousHistogram?: number; previousRsi?: number; bandExcursion?: "below" | "above"
  technical?:TechnicalState
  frame?:{bucket:number;candle:Candle;count:number;lastTimestamp:number;complete:boolean}
}
export interface TechnicalState {
  count:number;bars:Candle[];fast:number;slow:number;trSum:number;plusSum:number;minusSum:number;dxSum:number;dxCount:number
  atr?:number;plus?:number;minus?:number;adx?:number
  retest?:{direction:Direction;level:number;expires:number}
}
export interface ExecutionIntent {
  id: string; connectionId: string; laneId: string; configId: string; symbol: string; direction: Direction
  kind: "entry" | "add" | "close"; positionId: string; requestedQuantity: number
  timestamp: number; price: number; notional: number; takeProfitPct: number; stopLossPct: number; exitMode: ExitMode
  source: "real-qualified"; status: "pending" | "acknowledged" | "rejected"
  exchangeOrderId?: string; error?: string
  maxOrderNotional?:number
  qualificationId?:string
  minimumAddRatio?:number
  entryAllocationRatio?:number
  realPositionId?:string
  leverage?:number
}
export interface EngineEvent { type: "opened" | "added" | "closed" | "qualified" | "execution"; status?:string; reason?:string; laneId: string; timestamp: number; stage: Stage; trade?: ClosedTrade }
export interface EngineState {
  version: 1; settings: EngineSettings; lanes: Record<string, LaneState>; signals: Record<string, SignalState>
  lastMicroTimestamp?: Record<string, number>;
  lastTimestamp: Record<string, number>; recentTrades: ClosedTrade[]; intents: ExecutionIntent[]
  recentLiveTrades?: ClosedTrade[]
  nextActivationOrder?:number
  processedCandles: number; startedAt: number; updatedAt: number; equity: number; peakEquity: number; maxDrawdownPct: number
  equityHistory: { timestamp: number; equity: number; drawdownPct: number }[]
}
export interface StageMetrics { stage: Stage; lanes: number; open: number; closed: number; enoughSamples: number; enoughSamplesPct: number; qualified: number; profitFactor: number; pfState: ProfitFactorState; netPnl: number; wins:number; fees:number|null; longOpen:number; shortOpen:number; currentLanes:number; currentEnoughSamples:number; currentQualified:number; admissionReady:number; blockedByParent:number; currentProfitFactor:number; currentPfState:ProfitFactorState
  validatedWindow?:{samples:number;sets:number;profitFactor:number;pfState:ProfitFactorState;profit?:number;loss?:number}
  admittedForward?:{closes:number;profitFactor:number;pfState:ProfitFactorState;netPnl:number;unprovenCloses:number}
}
export interface EngineSnapshot {
  settings: EngineSettings; catalogCount: number; symbolCount: number; processedCandles: number; updatedAt: number
  equity: number; peakEquity: number; maxDrawdownPct: number; stages: StageMetrics[]
  positions: (PaperPosition & { laneId: string; symbol: string; configId: string; stage: Stage; coordination: Coordination })[]
  trades: ClosedTrade[]; intents: ExecutionIntent[]; equityHistory: EngineState["equityHistory"]
  liveTrades: ClosedTrade[]
  lanes: { id: string; symbol: string; configId: string; stage: Stage; direction: Direction; coordination: Coordination; count: number; required: number; enoughSamples: boolean; profitFactor: number; pfState: ProfitFactorState; qualified: boolean; netPnl: number;profit?:number;loss?:number;current?:boolean;admissionReady?:boolean;validated?:boolean;isOpen?:boolean }[]
}
