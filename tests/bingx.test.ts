import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { BingxVstClient, BINGX_VST_HOST, demoCredentials, normalizeSymbol, parseVenueJson, protectionOrders, signedQuery, stableClientOrderId, type OrderInput } from "../core/bingx"

const credentials = { apiKey: "unit-x02-key", apiSecret: "unit-x02-secret" }
const clientId = stableClientOrderId("x02", "candidate-1")
const entry: OrderInput = { symbol: "BTC-USDT", side: "BUY", positionSide: "LONG", quantity: "0.001", type: "MARKET", clientOrderId: clientId }
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 })
const order = { orderID: "2055068855617294300", symbol: "BTC-USDT", clientOrderId: clientId, side: "BUY", positionSide: "LONG", type: "MARKET", status: "FILLED", executedQty: "0.001", avgPrice: "100000" }
function fixture(handler: (url: URL, method: string) => Promise<Response> | Response) {
  const seen: Array<{ url: URL; method: string }> = []
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url)); const method = options?.method || "GET"
    assert.equal(parsed.origin, BINGX_VST_HOST)
    seen.push({ url: parsed, method })
    if (parsed.pathname.endsWith("/server/time")) return json({ serverTime: Date.now() })
    return handler(parsed, method)
  }
  const client = new BingxVstClient(credentials, { fetch: fetcher, minRequestIntervalMs: 0, sleep: async () => {} })
  return { client, seen }
}
function snapshotFixture(handler: (url: URL, method: string) => Promise<Response> | Response) {
  return fixture((url, method) => url.pathname.endsWith("/fillHistory") ? new Response("unsupported route", { status: 404 }) : handler(url, method))
}

test("malformed exchange inventories are not treated as empty", async () => {
  const malformedPositions=fixture(()=>json({unexpected:[]})).client
  await assert.rejects(()=>malformedPositions.positions(),/position inventory was not an array/)
  const malformedOrders=fixture(()=>json({unexpected:[]})).client
  await assert.rejects(()=>malformedOrders.openOrders(),/open-order inventory was not an array/)
  const unknownSide=fixture(()=>json([{symbol:"BTC-USDT",positionAmt:"1"}])).client
  await assert.rejects(()=>unknownSide.positions(),/position side was unavailable/)
  const badQuantity=fixture(()=>json([{symbol:"BTC-USDT",positionSide:"LONG",positionAmt:"invalid"}])).client
  await assert.rejects(()=>badQuantity.positions(),/quantity was invalid/)
})

test("x02 aliases never import mainnet credentials", () => {
  assert.equal(demoCredentials({ BINGX_API_KEY: "mainnet", BINGX_API_SECRET: "mainnet" }), null)
  assert.deepEqual(demoCredentials({ BINGX_X02_KEY: " demo ", BINGX_X02_SECRET: "secret" }), { apiKey: "demo", apiSecret: "secret" })
  assert.equal(demoCredentials({ BINGX_X02_KEY: "incomplete" }), null)
})

test("identity is stable, scoped to connection/candidate and within venue length", () => {
  assert.equal(clientId, stableClientOrderId("x02", "candidate-1"))
  assert.notEqual(clientId, stableClientOrderId("x01", "candidate-1"))
  assert.notEqual(clientId, stableClientOrderId("x02", "candidate-2"))
  assert.ok(clientId.length <= 40)
  assert.equal(normalizeSymbol("BTC/USDT"), "BTC-USDT")
  assert.throws(() => normalizeSymbol("https://foreign.example"))
})

test("signs raw sorted fields while encoding nested JSON exactly once", () => {
  const stopLoss = '{"type":"STOP_MARKET","stopPrice":61000,"label":"a&b=# ?"}'
  const params = { timestamp: 123, stopLoss, recvWindow: 5000 }
  const query = new URLSearchParams(signedQuery(params, "secret"))
  assert.equal(query.get("stopLoss"), stopLoss)
  assert.equal(query.get("signature"), createHmac("sha256", "secret").update(`recvWindow=5000&stopLoss=${stopLoss}&timestamp=123`).digest("hex"))
})

test("JSON numeric order IDs preserve all digits without altering string contents", () => {
  const parsed = parseVenueJson('{"orderId":2055068855617294300,"positionId":2055068855617294301,"price":123.5,"text":"\\\"orderId\\\":2055068855617294300"}') as Record<string, unknown>
  assert.equal(parsed.orderId, "2055068855617294300")
  assert.equal(parsed.positionId, "2055068855617294301")
  assert.equal(parsed.price, 123.5)
  assert.equal(parsed.text, '"orderId":2055068855617294300')
})

test("ambiguous POST reconciles by client ID with no POST retry", async () => {
  const { client, seen } = fixture((url, method) => {
    if (method === "POST") throw new Error("timeout after exchange accepted")
    assert.equal(url.searchParams.get("clientOrderId"), clientId)
    return json(order)
  })
  const result = await client.submitOrder(entry)
  assert.equal(result.status, "accepted")
  if (result.status === "accepted") { assert.equal(result.recovered, true); assert.equal(result.order.orderId, order.orderID) }
  assert.equal(seen.filter((call) => call.method === "POST").length, 1)
})

test("HTTP 503 and failed lookup stay unknown without replay", async () => {
  const { client, seen } = fixture((_url, method) => method === "POST" ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ code: 109421 }), { status: 200 }))
  assert.equal((await client.submitOrder(entry)).status, "unknown")
  assert.equal(seen.filter((call) => call.method === "POST").length, 1)
})

test("concurrent duplicate calls share one in-flight write", async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const { client, seen } = fixture(async (_url, method) => { if (method === "POST") await wait; return json(order) })
  const first = client.submitOrder(entry)
  const second = client.submitOrder(entry)
  release()
  const outcomes = await Promise.all([first, second])
  assert.equal(outcomes[0].status, "accepted")
  assert.deepEqual(outcomes[0], outcomes[1])
  assert.equal(seen.filter((call) => call.method === "POST").length, 1)
})

test("definite rejection does not become a fabricated fill", async () => {
  const { client, seen } = fixture(() => new Response(JSON.stringify({ code: 101204, msg: "margin" }), { status: 200 }))
  const result = await client.submitOrder(entry)
  assert.equal(result.status, "rejected")
  assert.equal(seen.filter((call) => call.url.pathname.endsWith("trade/order")).length, 1)
})

test("missing credentials sends no authenticated order", async () => {
  let calls = 0
  const client = new BingxVstClient(null, { fetch: async () => { calls++; return json({}) } })
  assert.equal((await client.submitOrder(entry)).status, "rejected")
  assert.equal(calls, 0)
})

test("attached protection has numeric fields and hedge close does not send reduceOnly", async () => {
  const { client, seen } = fixture(() => json(order))
  await client.submitOrder({ ...entry, stopLoss: 99000, takeProfit: 103000 })
  const parameters = seen.find((call) => call.method === "POST")!.url.searchParams
  assert.equal(JSON.parse(parameters.get("stopLoss")!).stopPrice, 99000)
  assert.equal(JSON.parse(parameters.get("takeProfit")!).stopPrice, 103000)
  await client.closePosition({ symbol: "BTC-USDT", direction: "LONG", quantity: "0.001", clientOrderId: stableClientOrderId("x02", "close-1") })
  const close = seen.filter((call) => call.method === "POST").at(-1)!.url.searchParams
  assert.equal(close.get("side"), "SELL")
  assert.equal(close.get("positionSide"), "LONG")
  assert.equal(close.has("reduceOnly"), false)
})

test("standalone conditional requests omit unsupported client ID and stay unknown on lost reply", async () => {
  const { client, seen } = fixture(() => { throw new Error("response lost") })
  const protect = protectionOrders({ ...entry, direction: "LONG", stopLoss: 99000, takeProfit: 103000 })
  assert.equal(protect.length, 2)
  assert.notEqual(protect[0].clientOrderId, protect[1].clientOrderId)
  const result = await client.submitOrder(protect[0])
  assert.equal(result.status, "unknown")
  assert.equal(seen.filter((call) => call.method === "POST").length, 1)
  assert.equal(seen.find((call) => call.method === "POST")!.url.searchParams.has("clientOrderId"), false)
})

test("read pacing applies to concurrent public calls", async () => {
  let time = 1000
  const starts: number[] = []
  const client = new BingxVstClient(null, { now: () => time, sleep: async (ms) => { time += ms }, minRequestIntervalMs: 210,
    fetch: async () => { starts.push(time); return json([]) } })
  await Promise.all([client.quotes(), client.quotes(), client.quotes()])
  assert.equal(starts.length, 3)
  assert.ok(starts[1] - starts[0] >= 210)
  assert.ok(starts[2] - starts[1] >= 210)
})

test("exchange commission is read in decimal-rate units", async () => {
  const { client } = fixture(() => json({ commission: { makerCommissionRate: "0.0005", takerCommissionRate: "0.0008" } }))
  assert.deepEqual(await client.commission("BTC-USDT"), { maker: 0.0005, taker: 0.0008, source: "exchange" })
})

test("cancellation rejects unrelated client identities before transport", async () => {
  const { client, seen } = fixture(() => json(order))
  await assert.rejects(client.cancelOwnedOrder("BTC-USDT", "manual-order"), /CTS-C/)
  assert.equal(seen.length, 0)
})

test("V3 array and nested balance envelopes select VST/USDT explicitly", async () => {
  const value = { asset: "VST", balance: "1000", equity: "1010", availableMargin: "900", unrealizedProfit: "10" }
  for (const shape of [[value], [{ balance: value }], { balance: value }]) {
    const { client } = fixture(() => json(shape))
    assert.deepEqual(await client.balance(), { asset: "VST", balance: 1000, equity: 1010, availableMargin: 900, unrealizedPnl: 10 })
  }
  const { client } = fixture(() => json([{ asset: "BTC", balance: 1 }]))
  await assert.rejects(client.balance(), /no VST\/USDT balance/)
})

test("closed-candle end time is transmitted and malformed ranges fail locally", async () => {
  const { client, seen } = fixture(() => json([]))
  const endTime = 1_762_732_799_999
  await client.candles("BTC-USDT", "1m", 1440, endTime)
  assert.equal(seen.at(-1)!.url.searchParams.get("endTime"), String(endTime))
  await assert.rejects(client.candles("BTC-USDT", "1m", 1440, NaN), /end time/)
  await assert.rejects(client.candles("BTC-USDT", "1m", 1440, 0), /end time/)
  assert.equal(seen.length, 1)
})

test("owned fill ledger preserves large IDs, signed fees and required native range fields", async () => {
  const native = '{"tradeId":2055068855617294399,"orderId":2055068855617294300,"symbol":"BTC-USDT","side":"BUY","price":"100000","qty":"0.001","realizedPnl":"0","fee":"-0.08","time":1762732700000}'
  const { client, seen } = snapshotFixture(() => new Response(`{"code":0,"data":{"fill_orders":[${native}]}}`))
  assert.deepEqual(await client.fills("2055068855617294300", 1762732600000, 1762732800000), [{ tradeId: "2055068855617294399", orderId: "2055068855617294300", symbol: "BTC-USDT", side: "BUY", price: 100000, quantity: 0.001, realizedPnl: 0, fee: -0.08, timestamp: 1762732700000 }])
  const request = seen.find((item) => item.url.pathname.endsWith("allFillOrders"))!
  assert.equal(request.method, "GET")
  assert.equal(request.url.searchParams.get("tradingUnit"), "COIN")
  assert.equal(request.url.searchParams.get("orderId"), "2055068855617294300")
  assert.equal(request.url.searchParams.get("startTs"), "1762732600000")
  assert.equal(request.url.searchParams.get("endTs"), "1762732800000")
})

test("fill accounting refuses foreign identities or fabricated missing amounts", async () => {
  const fill = { tradeId: "123", orderId: "456", symbol: "BTC-USDT", side: "SELL", price: 100, qty: 2, realizedPnl: 5, fee: 0.01, time: 1762732700000 }
  for (const shape of [[fill], { fillOrders: [fill] }, { orders: [fill] }]) {
    const { client } = snapshotFixture(() => json(shape))
    assert.equal((await client.fills("456", 1762732600000, 1762732800000))[0].fee, 0.01)
  }
  for (const value of [{ ...fill, orderId: "foreign" }, { ...fill, fee: undefined }, { ...fill, fee: null }, { ...fill, realizedPnl: "" }, { ...fill, qty: 0 }]) {
    const { client } = snapshotFixture(() => json([value]))
    await assert.rejects(client.fills("456", 1762732600000, 1762732800000), /fill/)
  }
  const { client, seen } = snapshotFixture(() => json({}))
  await assert.rejects(client.fills("456", 1762732600000, 1762732800000), /recognized fill array/)
  const requests = seen.length
  await assert.rejects(client.fills("456", 0, 1), /time range/)
  assert.equal(seen.length, requests)
})

test("lease guards run after asynchronous preflight and prevent exchange writes", async () => {
  const { client, seen } = fixture(() => json({...order,status:"NEW",executedQty:"0",avgPrice:"0"}))
  let submitGuardRan = false
  await assert.rejects(client.submitOrder(entry, () => {
    submitGuardRan = true
    assert.ok(seen.some((row) => row.url.pathname.endsWith("/server/time")))
    throw new Error("writer lease lost")
  }), /writer lease lost/)
  assert.equal(submitGuardRan, true)
  assert.equal(seen.filter((row) => row.method === "POST").length, 0)
  let cancelGuardRan = false
  await assert.rejects(client.cancelOwnedOrder("BTC-USDT", clientId, order.orderID, () => {
    cancelGuardRan = true
    assert.ok(seen.some((row) => row.url.pathname.endsWith("/trade/order") && row.method === "GET"))
    throw new Error("writer lease lost")
  }), /writer lease lost/)
  assert.equal(cancelGuardRan, true)
  assert.equal(seen.filter((row) => row.method === "DELETE").length, 0)
})

test("actual VST volume/commission envelope remains an exact order snapshot without invented trade IDs", async () => {
  const fill = { filledTm: "2026-11-10T14:34:00.000Z", volume: "3", price: "1.0597", amount: "3.1791", commission: "-0.001590", currency: "USDT", orderId: "2055068855617294300", filledTime: "2026-11-10T14:34:00.000Z", clientOrderID: "", symbol: "XRP-USDT", side: "BUY", positionSide: "LONG", type: "MARKET", triggerOrderId: 0 }
  const { client } = snapshotFixture(() => json({ fill_orders: [fill] }))
  const result = await client.fills(fill.orderId, 1794321000000, 1794322000000)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { tradeId: null, orderId: fill.orderId, symbol: "XRP-USDT", side: "BUY", quantity: 3, price: 1.0597, fee: -0.00159, timestamp: Date.parse(fill.filledTime), realizedPnl: null, granularity: "order" })
})

test("native partial fill rows aggregate quantity, weighted price and signed fees only within one owned order", async () => {
  const first = { filledTm: "2026-11-10T14:34:00.000Z", volume: "1", price: "100", commission: "-0.1", currency: "VST", orderId: "456", symbol: "BTC-USDT", side: "SELL" }
  const second = { ...first, volume: "2", price: "103", commission: "0.02", filledTm: "2026-11-10T14:34:01.000Z" }
  const { client } = snapshotFixture(() => json({ fill_orders: [first, second] }))
  const [snapshot] = await client.fills("456", 1794321000000, 1794322000000)
  assert.equal(snapshot.quantity, 3)
  assert.equal(snapshot.price, 102)
  assert.equal(snapshot.fee, -0.08)
  assert.equal(snapshot.timestamp, Date.parse(second.filledTm))
  assert.equal(snapshot.tradeId, null)
  assert.equal(snapshot.realizedPnl, null)
  for (const other of [{ ...second, orderId: "999" }, { ...second, currency: "BTC" }, { ...second, currency: "USDT" }, { ...second, commission: undefined }, { ...second, side: "BUY" }, { ...second, tradeId: "123" }]) {
    const malformed = snapshotFixture(() => json({ fill_orders: [first, other] }))
    await assert.rejects(malformed.client.fills("456", 1794321000000, 1794322000000), /fill/)
  }
})

test("actual fillHistory trades preserve exact IDs and realized PnL across every page", async () => {
  const fills = Array.from({ length: 101 }, (_, index) => ({ symbol: "XRP-USDT", qty: "0.1", quoteQty: "0.10597", role: "TAKER", commission: "-0.000053", commissionAsset: "USDT", price: "1.0597",
    orderId: "2055068855617294300", tradeId: String(2055068855617294399n + BigInt(index)), filledTime: "2026-11-10T14:34:00.000Z", clientOrderID: "", realisedPNL: index === 0 ? "0.0123" : "0", side: "SELL", positionSide: "LONG" }))
  const { client, seen } = fixture((url) => {
    assert.ok(url.pathname.endsWith("/fillHistory"), "supported fill history must not use snapshot fallback")
    assert.equal(url.searchParams.get("orderId"), fills[0].orderId)
    assert.equal(url.searchParams.get("pageSize"), "100")
    assert.equal(url.searchParams.get("tradingUnit"), "COIN")
    const page = Number(url.searchParams.get("pageIndex"))
    return json({ fill_history_orders: fills.slice((page - 1) * 100, page * 100), total: 101 })
  })
  const result = await client.fills(fills[0].orderId, 1794321000000, 1794322000000)
  assert.equal(result.length, 101)
  assert.equal(result[0].tradeId, "2055068855617294399")
  assert.equal(result[100].tradeId, "2055068855617294499")
  assert.equal(result[0].realizedPnl, 0.0123)
  assert.equal(result[0].fee, -0.000053)
  assert.equal(result[0].granularity, "trade")
  assert.equal(seen.filter((call) => call.url.pathname.endsWith("/fillHistory")).length, 2)
})

test("fill history auth and malformed responses never trigger weaker snapshot fallback", async () => {
  for (const response of [new Response(JSON.stringify({ code: 100001, msg: "invalid api key" }), { status: 200 }), json({ fill_history_orders: [], total: 1 }), json({ fill_orders: [] })]) {
    const { client, seen } = fixture(() => response.clone())
    await assert.rejects(client.fills("456", 1794321000000, 1794322000000))
    assert.equal(seen.some((call) => call.url.pathname.endsWith("/allFillOrders")), false)
  }
})

test("venue errors retain the actionable reason while redacting credentials and signatures", async () => {
  let signature = ""
  const { client } = fixture((url) => {
    signature = url.searchParams.get("signature") || ""
    return new Response(JSON.stringify({code:109400,msg:`Invalid order parameter; apiKey=${credentials.apiKey} apiSecret=${credentials.apiSecret} signature=${signature}`}),{status:200})
  })
  const result = await client.submitOrder(entry)
  assert.equal(result.status,"rejected")
  if (result.status === "rejected") {
    assert.match(result.reason,/Invalid order parameter/)
    for (const value of [credentials.apiKey,credentials.apiSecret,signature]) assert.ok(!result.reason.includes(value))
  }
})

test("generic109400 on a GET resynchronizes the clock once without retrying writes", async () => {
  let attempts=0
  const {client,seen}=fixture(()=>++attempts===1?new Response(JSON.stringify({code:109400,msg:"timestamp outside receive window"}),{status:200}):json({dualSidePosition:true}))
  assert.equal(await client.positionMode(),"hedge")
  assert.equal(attempts,2)
  assert.equal(seen.filter(call=>call.url.pathname.endsWith('/server/time')).length,2)
  assert.equal(seen.filter(call=>call.method==='POST').length,0)
})

test("bounded conditional evidence is read-only, symbol-scoped and preserves parent IDs", async () => {
  const {client,seen}=fixture(url=>{
    if(url.pathname.endsWith('/fillHistory'))assert.equal(url.searchParams.get('symbol'),'BTC-USDT')
    assert.equal(url.searchParams.get('orderId'),null)
    const value={symbol:'BTC-USDT',orderId:'2055068855617294300',triggerOrderId:'2055068855617294299',status:'FILLED',apiKey:'private-value',arbitrary:'not-evidence'}
    if(url.pathname.endsWith('/allFillOrders'))return json({fill_orders:[value]})
    if(url.pathname.endsWith('/fillHistory'))return json({fill_history_orders:[value],total:1})
    return json({orders:[value,{symbol:'ETH-USDT',orderId:'999',triggerOrderId:'123'}]})
  })
  const evidence=await client.historyEvidence('BTC-USDT',1,100)
  assert.equal(evidence.errors.length,0)
  assert.equal(evidence.orders.length,1)
  assert.equal(evidence.fullOrders.length,1)
  assert.equal(evidence.trades[0].triggerOrderId,'2055068855617294299')
  assert.equal(evidence.trades[0].apiKey,undefined)
  assert.equal(evidence.trades[0].arbitrary,undefined)
  assert.ok(seen.every(call=>call.method==='GET'))
  assert.equal((parseVenueJson('{"triggerOrderId":2055068855617294299}')as{triggerOrderId:string}).triggerOrderId,'2055068855617294299')
  await assert.rejects(client.historyEvidence('BTC-USDT',1,86_400_002),/at most one day/)
})

test("native conditional GET may return its filled child only with exact trigger-parent identity", async () => {
  const parent='2120171627236384768',child='2120171672427302912'
  const {client,seen}=fixture(()=>new Response(`{"code":0,"data":{"orderId":${child},"triggerOrderId":${parent},"symbol":"XRP-USDT","status":"FILLED","type":"STOP_MARKET","executedQty":"2","avgPrice":"1.0650"}}`,{status:200}))
  const filled=await client.orderById('XRP-USDT',parent)
  assert.equal(filled.orderId,child)
  assert.equal(filled.triggerOrderId,parent)
  const canceled=await client.cancelOwnedOrder('XRP-USDT',clientId,parent)
  assert.equal(canceled.status,'accepted')
  assert.equal(seen.filter(call=>call.method==='DELETE').length,0)
  const wrong=fixture(()=>json({...order,orderId:child,triggerOrderId:'999'})).client
  await assert.rejects(wrong.orderById('XRP-USDT',parent),/exact trigger-parent/)
})
