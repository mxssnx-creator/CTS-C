import type { Direction, ExitMode } from "./types"
type ExitReason="trailing_stop"|"stop_loss"|"take_profit"|"max_hold"
type ExitInput={ direction: Direction; entryPrice: number; peak: number; price: number; takeProfitPct: number; stopLossPct: number; exitMode: ExitMode; openedAt: number; timestamp: number; maxHoldMinutes: number; trailingBasis?: "peak" | "entry";trailingReferencePrice?:number;trailDistancePct?:number;trailingActive?:boolean;trailingStopPrice?:number;trailingEnabled?:boolean }
type Observation=Pick<ExitInput,'price'|'timestamp'|'trailingEnabled'|'trailingBasis'>
type ExitResult={peak:number;stop:number;trailingActive:boolean;reason:ExitReason|undefined}

export function isFixedTrailing(mode: ExitMode): boolean {
  return mode === "trailing-fixed" || mode === "trailing-only-fixed"
}

/** One observed-price exit policy for replay, closed bars and live quote ticks. */
export function observedExit(input:ExitInput):ExitResult
export function observedExit(input:Omit<ExitInput,'price'|'timestamp'>,observation:Observation):ExitResult
export function observedExit(input:Omit<ExitInput,'price'|'timestamp'>&Partial<ExitInput>,observation?:Observation):ExitResult {
  const price=observation?.price??input.price!,timestamp=observation?.timestamp??input.timestamp!,trailingEnabled=observation?.trailingEnabled??input.trailingEnabled,basis=observation?.trailingBasis??input.trailingBasis
  const sign=input.direction==="long"?1:-1
  const peak=trailingEnabled===false?input.peak:sign===1?Math.max(input.peak,price):Math.min(input.peak,price)
  const move=sign*(price-input.entryPrice)/input.entryPrice*100
  const peakMove=sign*(peak-input.entryPrice)/input.entryPrice*100
  const immediate = input.exitMode === "trailing-only" || input.exitMode === "trailing-only-fixed"
  const trailingActive=input.exitMode!=="fixed"&&(trailingEnabled===false?input.trailingActive===true:(input.trailingActive===true||immediate||peakMove>=input.takeProfitPct))
  const initial=input.entryPrice*(1-sign*input.stopLossPct/100)
  const gapReference = isFixedTrailing(input.exitMode)
    ? input.trailingReferencePrice ?? input.entryPrice
    : basis === "entry" ? input.entryPrice : peak
  const trail=peak-sign*gapReference*(input.trailDistancePct??input.stopLossPct)/100
  const previous=input.trailingStopPrice??initial
  const stop=trailingEnabled===false?(sign===1?Math.max(initial,previous):Math.min(initial,previous)):trailingActive?(sign===1?Math.max(initial,trail,previous):Math.min(initial,trail,previous)):initial
  const reason:ExitReason|undefined=sign*(price-stop)<=0?(trailingActive?"trailing_stop":"stop_loss")
    :input.exitMode==="fixed"&&move>=input.takeProfitPct?"take_profit"
    :input.maxHoldMinutes>0&&timestamp-input.openedAt>=input.maxHoldMinutes*60_000?"max_hold":undefined
  return {peak,stop,trailingActive,reason}
}
