import type { Candle as VenueCandle } from './bingx'
import type { Candle } from './types'

interface HistorySource { candles(symbol:string,interval:string,limit:number,endTime?:number):Promise<VenueCandle[]> }
const MINUTE = 60_000
export interface HistoryPlan { count:number; cutoff:number; cursor:number|null }
/** Fetch the oldest missing chunk first, even when the interruption exceeds the configured history size. */
export function planHistory(configuredCount:number,cursor:number|null,now=Date.now()):HistoryPlan {
  if(!Number.isInteger(configuredCount)||configuredCount<100||configuredCount>1440)throw new Error('History count must be 100..1440')
  const latest=Math.floor(now/MINUTE)*MINUTE
  if(cursor===null)return {count:configuredCount,cutoff:latest,cursor}
  if(!Number.isSafeInteger(cursor)||cursor<=0||cursor%MINUTE!==0||cursor>latest)throw new Error('Invalid or future history cursor')
  const cutoff=Math.min(latest,cursor+configuredCount*MINUTE)
  return {count:Math.min(configuredCount,Math.max(100,Math.ceil((cutoff-cursor)/MINUTE)+1)),cutoff,cursor}
}
/** Reject gaps before mutating the indicator, stage or position ledger. */
export function validateHistory(symbol:string,candles:Candle[],plan:HistoryPlan):void {
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
  if(!Number.isInteger(count)||count<100||count>1440)throw new Error('History count must be 100..1440')
  const rows=new Map<number,VenueCandle>()
  let endTime=Math.floor(cutoff/60_000)*60_000-1
  for(let page=0;page<3&&rows.size<count;page++){
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
  if(result.length<2)throw new Error(`Insufficient observed history for ${symbol}`)
  return result.map(c=>({timestamp:c.time+60_000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}))
}
