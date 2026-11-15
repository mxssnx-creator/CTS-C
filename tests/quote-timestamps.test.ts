import assert from 'node:assert/strict'
import {test} from 'node:test'
import {BingxVstClient,BINGX_VST_HOST} from '../core/bingx'

const now=1794744000000
function fixture(data:unknown[]){
 const requests:string[]=[]
 const client=new BingxVstClient({apiKey:'quote-fixture-key',apiSecret:'quote-fixture-secret'},{now:()=>now,minRequestIntervalMs:0,sleep:async()=>{},fetch:async(url,init)=>{
  const parsed=new URL(String(url));assert.equal(parsed.origin,BINGX_VST_HOST);assert.equal(init?.method??'GET','GET');requests.push(parsed.pathname)
  assert.equal(parsed.pathname,'/openApi/swap/v1/ticker/price')
  return new Response(JSON.stringify({code:0,data}),{status:200,headers:{'content-type':'application/json'}})
 }})
 return {client,requests}
}

test('quotes with unknown or invalid venue times never acquire a fabricated local timestamp',async()=>{
 const values=[undefined,null,0,-1,'not-a-time',1.5,Number.MAX_SAFE_INTEGER+1]
 const {client,requests}=fixture(values.map(time=>({symbol:'BTC-USDT',price:100,time})))
 assert.deepEqual(await client.quotes(),[])
 assert.deepEqual(requests,['/openApi/swap/v1/ticker/price'])
})

test('both venue timestamp aliases retain their actual age for runtime freshness checks',async()=>{
 const {client}=fixture([{symbol:'BTC-USDT',price:'100',time:String(now-20000)},{symbol:'ETH-USDT',price:200,timestamp:now+60000},{symbol:'SOL-USDT',price:300,time:null,timestamp:now}])
 assert.deepEqual(await client.quotes(),[{symbol:'BTC-USDT',price:100,timestamp:now-20000},{symbol:'ETH-USDT',price:200,timestamp:now+60000},{symbol:'SOL-USDT',price:300,timestamp:now}])
})
