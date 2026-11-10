import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/core/auth'
import { getMarketCandles, marketInterval, marketSymbol, marketVenue } from '@/core/market'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request); if (denied) return denied
  const p = request.nextUrl.searchParams
  let symbol: string, interval: string, venue: ReturnType<typeof marketVenue>
  try { symbol=marketSymbol(p.get('symbol')??'BTC-USDT'); interval=marketInterval(p.get('interval')??'5m'); venue=marketVenue(p.get('exchange')??'bingx') }
  catch(error) { return NextResponse.json({error:(error as Error).message},{status:400}) }
  try {
    const demo=p.get('demo')==='true'
    return NextResponse.json({success:true,symbol,interval,source:`${venue}:${demo?'demo':'public'}`,data:await getMarketCandles(venue,symbol,interval,demo),receivedAt:Date.now()})
  } catch {return NextResponse.json({success:false,error:'Exchange market feed unavailable',data:null},{status:502})}
}
