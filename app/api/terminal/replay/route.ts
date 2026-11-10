import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/core/auth'
import { getResearchCandles, intervalSeconds, marketSymbol, marketInterval, marketVenue } from '@/core/market'
import { runTerminalReplayAsync } from '@/core/terminal-replay'
import { getStore } from '@/core/store'
import {connectionInfo} from '@/core/connections'
import {TECHNICAL_INDICATIONS} from '@/core/indications'
export const runtime='nodejs'
export const dynamic='force-dynamic'
let inFlight=false
export async function POST(request: NextRequest) {
  const denied=requireAdmin(request); if(denied)return denied
  if(inFlight)return NextResponse.json({error:'A replay is already running'},{status:409})
  inFlight=true
  try {
    let body
    try{body=await request.json()}catch{return NextResponse.json({success:false,error:'Invalid replay request'},{status:400})}
    if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({success:false,error:'Invalid replay request'},{status:400})
    let symbol:string,interval:string,venue:ReturnType<typeof marketVenue>
    try{symbol=marketSymbol(body.symbol??'BTC-USDT');interval=marketInterval(body.interval??'5m');venue=marketVenue(body.exchange??'bingx')}
    catch(error){return NextResponse.json({success:false,error:error instanceof Error?error.message:'Invalid market selection'},{status:400})}
    const limit=body.candles??1000
    if(!Number.isInteger(limit)||limit<100||limit>5000)return NextResponse.json({success:false,error:'Choose 100..5000 research candles'},{status:400})
    const connection=connectionInfo(body.connectionId??undefined)
    const settings=getStore(connection.id).engineSettings()
    if(interval!=='1m'&&Array.isArray(settings?.catalog.strategyIndicationTypes)&&settings.catalog.strategyIndicationTypes.some(t=>(TECHNICAL_INDICATIONS as readonly unknown[]).includes(t)))return NextResponse.json({success:false,error:'Trend and Break timeframe grids require one-minute source candles. Select 1m.'},{status:400})
    const candles=await getResearchCandles(venue,symbol,interval,typeof body.demo==='boolean'?body.demo:connection.demo,limit)
    const study=await runTerminalReplayAsync(symbol,candles,{...settings?.catalog,...settings?.symbolFees?.[symbol],mainEvalPosCount:settings?.stageLastN.base??20,baseProfitFactor:settings?.stageMinPF.base??1.1,replayBarSeconds:intervalSeconds(interval)},request.signal)
    const result={success:true,connectionId:connection.id,source:`${venue}:${connection.demo?'demo':'public'}`,createdAt:Date.now(),...study}
    getStore(connection.id).set('lastReplay',result)
    return NextResponse.json(result)
  } catch(error) {return NextResponse.json({success:false,error:error instanceof Error?`Replay unavailable: ${error.message}`:'Replay unavailable'},{status:502})}
  finally {inFlight=false}
}
