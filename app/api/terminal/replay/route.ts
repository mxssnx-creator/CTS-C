import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/core/auth'
import { getMarketCandles, marketSymbol, marketInterval, marketVenue } from '@/core/market'
import { runTerminalReplay } from '@/core/terminal-replay'
import { getStore } from '@/core/store'
import type { EngineState } from '@/core/types'
export const runtime='nodejs'
export const dynamic='force-dynamic'
let inFlight=false
export async function POST(request: NextRequest) {
  const denied=requireAdmin(request); if(denied)return denied
  if(inFlight)return NextResponse.json({error:'A replay is already running'},{status:409})
  inFlight=true
  try {
    const body=await request.json()
    const symbol=marketSymbol(body.symbol??'BTC-USDT'), interval=marketInterval(body.interval??'5m'), venue=marketVenue(body.exchange??'bingx')
    const candles=await getMarketCandles(venue,symbol,interval,body.demo===true)
    const settings=getStore().get<EngineState>('engine')?.settings
    const study=runTerminalReplay(symbol,candles,{...settings?.catalog,mainEvalPosCount:settings?.stageLastN.base??8,baseProfitFactor:settings?.stageMinPF.base??1.05})
    const result={success:true,source:`${venue}:${body.demo?'demo':'public'}`,createdAt:Date.now(),...study}
    getStore().set('lastReplay',result)
    return NextResponse.json(result)
  } catch {return NextResponse.json({success:false,error:'Replay unavailable: verify exchange connectivity and strategy settings'},{status:502})}
  finally {inFlight=false}
}
