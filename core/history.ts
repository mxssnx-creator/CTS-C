import type { Candle as VenueCandle } from './bingx'
import type { Candle } from './types'
import { MIN_WARMUP_CANDLES, MAX_WARMUP_CANDLES, validWarmupCount } from './history-policy.mjs'

interface HistorySource { candles(symbol:string,interval:string,limit:number,endTime?:number):Promise<VenueCandle[]> }
const MINUTE = 60_000
const MAX_PAGE_HISTORY_CANDLES = 4320
export { MAX_WARMUP_CANDLES }
export interface HistoryPlan { count:number; cutoff:number; cursor:number|null }
/** Fetch the oldest missing chunk first, even when the interruption exceeds the configured history size. */
export function planHistory(configuredCount:number,cursor:number|null,now=Date.now()):HistoryPlan {
  if(!validWarmupCount(configuredCount))throw new Error(`History count must be ${MIN_WARMUP_CANDLES}..${MAX_WARMUP_CANDLES}`)
  const latest=Math.floor(now/MINUTE)*MINUTE
  const page = Math.min(configuredCount,MAX_PAGE_HISTORY_CANDLES)
  if(cursor===null)return {count:page,cutoff:latest-(configuredCount-page)*MINUTE,cursor}
  if(!Number.isSafeInteger(cursor)||cursor<=0||cursor%MINUTE!==0||cursor>latest)throw new Error('Invalid or future history cursor')
  const cutoff=Math.min(latest,cursor+page*MINUTE)
  return {count:(cutoff-cursor)/MINUTE,cutoff,cursor}
}
/** Reject gaps before mutating the indicator, stage or position ledger. */
export function validateHistory(symbol:string,candles:Candle[],plan:HistoryPlan):void {
  if(plan.cursor===null&&candles.length!==plan.count)throw new Error(`Unexpected history count for ${symbol}: ${candles.length}/${plan.count} candles`)
  const unseen=plan.cursor===null?candles:candles.filter(c=>c.timestamp>plan.cursor!)
  if(plan.cursor===plan.cutoff&&unseen.length===0)return
  if(!unseen.length||unseen.at(-1)!.timestamp!==plan.cutoff)throw new Error(`Incomplete observed history for ${symbol}`)
  let previous=plan.cursor??unseen[0].timestamp-MINUTE
  for(const candle of unseen){
    if(candle.timestamp!==previous+MINUTE)throw new Error(`Missing observed history for ${symbol}`)
    previous=candle.timestamp
  }
}
/** Backfill observed closed minutes; BingX VST may cap a page at 1,000. */
export async function closedHistory(source:HistorySource,symbol:string,count:number,cutoff=Date.now()):Promise<Candle[]> {
  if(!Number.isInteger(count)||count<1||count>MAX_PAGE_HISTORY_CANDLES)throw new Error(`History page count must be 1..${MAX_PAGE_HISTORY_CANDLES}`)
  const rows=new Map<number,VenueCandle>()
  let endTime=Math.floor(cutoff/60_000)*60_000-1
  for(let page=0;page<Math.ceil(count/1000)+1&&rows.size<count;page++){
    const data=await source.candles(symbol,'1m',Math.min(1000,count-rows.size+1),endTime)
    const closed=data.filter(c=>c.time+60_000<=cutoff&&c.time<=endTime)
    if(!closed.length)break
    const previousSize=rows.size
    for(const candle of closed)rows.set(candle.time,candle)
    const oldest=Math.min(...closed.map(c=>c.time))
    if(rows.size===previousSize||oldest>=endTime)break
    endTime=oldest-1
  }
  const result=[...rows.values()].sort((a,b)=>a.time-b.time).slice(-count)
  if(result.length<Math.min(2,count))throw new Error(`Insufficient observed history for ${symbol}`)
  return result.map(c=>({timestamp:c.time+60_000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}))
}
