export type MarketVenue = "bingx" | "bybit"
export interface MarketCandle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface MarketQuote { symbol: string; price: number; last: number; timestamp: number; source: string }
const intervals = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"])
const cache = new Map<string, { expires: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
let candleQueue: Promise<unknown> = Promise.resolve()
let lastCandleRequest = 0

export function marketSymbol(input: unknown): string {
  const symbol = String(input ?? "BTC-USDT").toUpperCase().replace(/[/_-]/g, "")
  if (!/^[A-Z0-9]{1,30}USDT$/.test(symbol)) throw new Error("Use a USDT market symbol, for example BTC-USDT")
  return symbol.slice(0, -4) + "-USDT"
}
export function marketVenue(input: unknown): MarketVenue {
  const venue = String(input ?? "bingx").toLowerCase()
  if (venue !== "bingx" && venue !== "bybit") throw new Error("Public market data supports BingX and Bybit")
  return venue
}
export function marketInterval(input: unknown): string {
  const value = String(input ?? "1m")
  if (!intervals.has(value)) throw new Error("Unsupported candle interval")
  return value
}
export function intervalSeconds(interval:string):number {
  marketInterval(interval)
  return Number(interval.slice(0,-1))*({m:60,h:3600,d:86400}[interval.at(-1)!]!)
}
async function cached<T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> {
  const current = cache.get(key)
  if (current && current.expires > Date.now()) return current.value as T
  if (pending.has(key)) return pending.get(key) as Promise<T>
  const task = work().then(value => {
    if (cache.size >= 500) cache.delete(cache.keys().next().value!)
    cache.set(key, { value, expires: Date.now() + ttl })
    return value
  }).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
async function read(url: URL): Promise<any> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Market data upstream returned HTTP ${response.status}`)
  const body = await response.json()
  if (Number(body.code ?? body.retCode ?? 0) !== 0) throw new Error("Market data upstream rejected the request")
  return body
}
function endpoint(venue: MarketVenue, demo: boolean, path: string): URL {
  const host = venue === "bingx"
    ? (demo ? "https://open-api-vst.bingx.com" : "https://open-api.bingx.com")
    : (demo ? "https://api-testnet.bybit.com" : "https://api.bybit.com")
  return new URL(path, host)
}
export function normalizeCandles(rows: unknown[], venue: MarketVenue): MarketCandle[] {
  if (!Array.isArray(rows)) throw new Error("Invalid candle response")
  const normalized = rows.map((row: any) => {
    const [time, open, high, low, close, volume] = venue === "bybit"
      ? row : [row.time, row.open, row.high, row.low, row.close, row.volume]
    return { time: Math.floor(Number(time) / 1000), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }
  })
  if (!normalized.length || normalized.some(c => Object.values(c).some(v => !Number.isFinite(v)) || c.time <= 0 || c.low <= 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.volume < 0)) throw new Error("Market data contains invalid candles")
  return [...new Map(normalized.map(c => [c.time, c])).values()].sort((a, b) => a.time - b.time)
}
export async function getMarketCandles(venue: MarketVenue, symbol: string, interval: string, demo: boolean, options:{limit?:number;endTime?:number}={}): Promise<MarketCandle[]> {
  marketInterval(interval)
  symbol = marketSymbol(symbol)
  const limit=options.limit??200
  if(!Number.isInteger(limit)||limit<1||limit>1000||options.endTime!==undefined&&(!Number.isSafeInteger(options.endTime)||options.endTime<=0))throw new Error("Invalid market history request")
  return cached(`candles:${venue}:${demo}:${symbol}:${interval}:${limit}:${options.endTime??"latest"}`, 15_000, async () => {
    const job = candleQueue.catch(() => {}).then(async () => {
      const remaining = 1100 - (Date.now() - lastCandleRequest)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      lastCandleRequest = Date.now()
      const url = endpoint(venue, demo, venue === "bingx" ? "/openApi/swap/v3/quote/klines" : "/v5/market/kline")
      url.searchParams.set("symbol", venue === "bingx" ? symbol : symbol.replace("-", ""))
      url.searchParams.set("interval", venue === "bingx" ? interval : ({ "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" }[interval]!))
      url.searchParams.set("limit", String(limit))
      if(options.endTime!==undefined)url.searchParams.set(venue==="bingx"?"endTime":"end",String(options.endTime))
      if (venue === "bybit") url.searchParams.set("category", "linear")
      const body = await read(url)
      return normalizeCandles(venue === "bingx" ? body.data : body.result?.list, venue)
    })
    candleQueue = job
    return job
  })
}
/** Completed chronological history for research; the live chart may include its forming bar. */
export async function getResearchCandles(venue:MarketVenue,symbol:string,interval:string,demo:boolean,count=1000,cutoff=Date.now()):Promise<MarketCandle[]>{
  if(!Number.isInteger(count)||count<100||count>5000)throw new Error("Research candles must be 100..5000")
  const duration=intervalSeconds(interval), rows=new Map<number,MarketCandle>()
  let endTime=Math.floor(cutoff/(duration*1000))*duration*1000-1
  for(let page=0;page<Math.ceil(count/1000)+1&&rows.size<count;page++){
    const batch=await getMarketCandles(venue,symbol,interval,demo,{limit:Math.min(1000,count-rows.size+1),endTime})
    const closed=batch.filter(c=>c.time*1000<=endTime&&(c.time+duration)*1000<=cutoff)
    if(!closed.length)break
    const before=rows.size
    for(const candle of closed)rows.set(candle.time,candle)
    if(rows.size===before)break
    endTime=closed[0].time*1000-1
  }
  const result=[...rows.values()].sort((a,b)=>a.time-b.time).slice(-count)
  if(result.length<100)throw new Error("Insufficient completed research candles")
  if(result.at(-1)!.time+duration!==Math.floor(cutoff/(duration*1000))*duration)throw new Error("Research history is stale")
  if(result.some((c,i)=>i>0&&c.time-result[i-1].time!==duration))throw new Error("Research history has missing candles")
  return result
}
export async function getMarketQuotes(venue: MarketVenue, symbols: string[], demo: boolean): Promise<Record<string, MarketQuote>> {
  const canonical = symbols.map(marketSymbol)
  const all = await cached(`quotes:${venue}:${demo}`, 3000, async () => {
    const url = endpoint(venue, demo, venue === "bingx" ? "/openApi/swap/v1/ticker/price" : "/v5/market/tickers")
    if (venue === "bybit") url.searchParams.set("category", "linear")
    const body = await read(url)
    const rows = venue === "bingx" ? body.data : body.result?.list
    if (!Array.isArray(rows)) throw new Error("Invalid market quote response")
    const quotes: Record<string, MarketQuote> = {}
    for (const row of rows) {
      if (!String(row.symbol).replace("-", "").endsWith("USDT")) continue
      // A venue may also list indices or non-ASCII token names. One unsupported
      // market must not make otherwise valid requested quotes unavailable.
      let symbol: string
      try { symbol = marketSymbol(row.symbol) } catch { continue }
      const price = Number(row.price ?? row.lastPrice)
      if (Number.isFinite(price) && price > 0) quotes[symbol] = { symbol, price, last: price, timestamp: Number(row.time ?? body.time ?? Date.now()), source: `${venue}:${demo ? "demo" : "public"}` }
    }
    return quotes
  })
  const result: Record<string, MarketQuote> = {}
  for (let i = 0; i < canonical.length; i++) {
    if (!all[canonical[i]]) throw new Error(`No current quote for ${canonical[i]}`)
    result[symbols[i]] = all[canonical[i]]
  }
  return result
}
