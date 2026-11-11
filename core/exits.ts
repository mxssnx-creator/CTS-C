import type { Direction, ExitMode } from "./types"
type ExitReason="trailing_stop"|"stop_loss"|"take_profit"|"max_hold"

/** One observed-price exit policy for replay, closed bars and live quote ticks. */
export function observedExit(input: { direction: Direction; entryPrice: number; peak: number; price: number; takeProfitPct: number; stopLossPct: number; exitMode: ExitMode; openedAt: number; timestamp: number; maxHoldMinutes: number; trailingBasis?: "peak" | "entry";trailDistancePct?:number;trailingActive?:boolean;trailingStopPrice?:number;trailingEnabled?:boolean }) {
  const sign=input.direction==="long"?1:-1
  const peak=input.trailingEnabled===false?input.peak:sign===1?Math.max(input.peak,input.price):Math.min(input.peak,input.price)
  const move=sign*(input.price-input.entryPrice)/input.entryPrice*100
  const peakMove=sign*(peak-input.entryPrice)/input.entryPrice*100
  const trailingActive=input.exitMode!=="fixed"&&(input.trailingEnabled===false?input.trailingActive===true:(input.trailingActive===true||input.exitMode==="trailing-only"||peakMove>=input.takeProfitPct))
  const initial=input.entryPrice*(1-sign*input.stopLossPct/100)
  const trail=peak-sign*(input.trailingBasis==="entry"?input.entryPrice:peak)*(input.trailDistancePct??input.stopLossPct)/100
  const previous=input.trailingStopPrice??initial
  const stop=input.trailingEnabled===false?(sign===1?Math.max(initial,previous):Math.min(initial,previous)):trailingActive?(sign===1?Math.max(initial,trail,previous):Math.min(initial,trail,previous)):initial
  const reason:ExitReason|undefined=sign*(input.price-stop)<=0?(trailingActive?"trailing_stop":"stop_loss")
    :input.exitMode==="fixed"&&move>=input.takeProfitPct?"take_profit"
    :input.maxHoldMinutes>0&&input.timestamp-input.openedAt>=input.maxHoldMinutes*60_000?"max_hold":undefined
  return {peak,stop,trailingActive,reason}
}
