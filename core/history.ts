import type { Candle as VenueCandle } from './bingx'
import type { Candle } from './types'

interface HistorySource { candles(symbol:string,interval:string,limit:number,endTime?:number):Promise<VenueCandle[]> }
/** Restored indicators already own their prefix; fetch only the missing tail. */
export function resumeHistoryCount(configuredCount:number,lastClosedAt:number|null,now=Date.now()):number {
  if(lastClosedAt===null)return configuredCount
  return Math.min(configuredCount,Math.max(100,Math.ceil((now-lastClosedAt)/60_000)+1))
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
