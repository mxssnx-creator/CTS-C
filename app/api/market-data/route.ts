import { requireAdmin } from "@/core/auth"
import { NextRequest, NextResponse } from "next/server"
import { getMarketQuotes, marketSymbol, marketVenue } from "@/core/market"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request); if (denied) return denied
  const params = request.nextUrl.searchParams
  let symbol: string, venue: ReturnType<typeof marketVenue>
  try { symbol = marketSymbol(params.get("symbol") ?? "BTC-USDT"); venue = marketVenue(params.get("exchange") ?? "bingx") }
  catch (error) { return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 }) }
  try {
    const quotes = await getMarketQuotes(venue, [symbol], params.get("demo") === "true")
    return NextResponse.json({ success: true, data: quotes[symbol] })
  } catch { return NextResponse.json({ success: false, error: "Market feed unavailable", data: null }, { status: 502 }) }
}
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request); if (denied) return denied
  let symbols: string[], venue: ReturnType<typeof marketVenue>, demo: boolean
  try {
    const body = await request.json()
    if (!Array.isArray(body.symbols) || body.symbols.length < 1 || body.symbols.length > 500) throw new Error("Provide between 1 and 500 symbols")
    symbols = body.symbols
    symbols.forEach(marketSymbol)
    venue = marketVenue(body.exchange)
    demo = body.demo === true
  } catch (error) { return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 }) }
  try {
    const data = await getMarketQuotes(venue, symbols, demo)
    return NextResponse.json({ success: true, count: Object.keys(data).length, data })
  } catch { return NextResponse.json({ success: false, error: "Market feed unavailable", data: null }, { status: 502 }) }
}
