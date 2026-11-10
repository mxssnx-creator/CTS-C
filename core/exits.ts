import type { Direction, ExitMode } from "./types"
type ExitReason="trailing_stop"|"stop_loss"|"take_profit"|"max_hold"

/** One observed-price exit policy for replay, closed bars and live quote ticks. */
export function observedExit(input: { direction: Direction; entryPrice: number; peak: number; price: number; takeProfitPct: number; stopLossPct: number; exitMode: ExitMode; openedAt: number; timestamp: number; maxHoldMinutes: number; trailingBasis?: "peak" | "entry" }) {
  const sign=input.direction==="long"?1:-1
  const peak=sign===1?Math.max(input.peak,input.price):Math.min(input.peak,input.price)
  const move=sign*(input.price-input.entryPrice)/input.entryPrice*100
  const peakMove=sign*(peak-input.entryPrice)/input.entryPrice*100
  const trailingActive=input.exitMode==="trailing-only"||(input.exitMode==="trailing"&&peakMove>=input.takeProfitPct)
  const initial=input.entryPrice*(1-sign*input.stopLossPct/100)
  const trail=peak-sign*(input.trailingBasis==="entry"?input.entryPrice:peak)*input.stopLossPct/100
  const stop=trailingActive?(sign===1?Math.max(initial,trail):Math.min(initial,trail)):initial
  const reason:ExitReason|undefined=sign*(input.price-stop)<=0?(trailingActive?"trailing_stop":"stop_loss")
    :input.exitMode==="fixed"&&move>=input.takeProfitPct?"take_profit"
    :input.maxHoldMinutes>0&&input.timestamp-input.openedAt>=input.maxHoldMinutes*60_000?"max_hold":undefined
  return {peak,stop,trailingActive,reason}
}
