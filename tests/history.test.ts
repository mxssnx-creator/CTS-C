import assert from 'node:assert/strict'
import {test} from 'node:test'
import {closedHistory,planHistory,validateHistory} from '../core/history'

test('restart history uses retained cursors without dropping the unseen closed tail',async()=>{
  const start=1700000040000,now=start+1600*60000
  assert.deepEqual(planHistory(1440,null,now),{count:1440,cutoff:now,cursor:null})
  assert.equal(planHistory(1440,now-3*60000,now).count,100)
  assert.equal(planHistory(1440,now-200*60000,now).count,201)
  assert.equal(planHistory(1440,now-2000*60000,now).cutoff,now-560*60000)
  assert.equal(planHistory(100,now-200*60000,now).cutoff,now-100*60000)
  const cursor=now-200*60000
  const candles=Array.from({length:1600},(_,i)=>({time:start+i*60000,open:100,high:101,low:99,close:100,volume:1}))
  let requests=0
  const plan=planHistory(1440,cursor,now)
  const result=await closedHistory({async candles(_s,_i,limit,endTime){requests++;return candles.filter(c=>c.time<=endTime!).slice(-limit)}},'BTC-USDT',plan.count,plan.cutoff)
  validateHistory('BTC-USDT',result,plan)
  assert.equal(requests,1)
  assert.equal(result.filter(c=>c.timestamp>cursor).length,200)
  assert.equal(result.at(-1)?.timestamp,now)
})

test('multi-day recovery applies every missing minute in chronological chunks',async()=>{
  const start=1700000040000, now=start+3300*60000, rows=Array.from({length:3300},(_,i)=>({time:start+i*60000,open:100,high:101,low:99,close:100,volume:1}))
  let cursor=start, recovered:number[]=[]
  while(cursor<now){
    const plan=planHistory(1440,cursor,now)
    const batch=await closedHistory({async candles(_s,_i,limit,endTime){return rows.filter(c=>c.time<=endTime!).slice(-Math.min(limit,1000))}},'BTC-USDT',plan.count,plan.cutoff)
    validateHistory('BTC-USDT',batch,plan)
    recovered.push(...batch.filter(c=>c.timestamp>cursor).map(c=>c.timestamp))
    cursor=plan.cutoff
  }
  assert.equal(recovered.length,3300)
  assert.equal(recovered[0],start+60000)
  assert.equal(recovered.at(-1),now)
  assert.ok(recovered.every((t,i)=>i===0||t-recovered[i-1]===60000))
})

test('missing or stale history cannot advance a restored cursor',()=>{
  const cursor=1700000040000, plan=planHistory(100,cursor,cursor+3*60000)
  const candle=(timestamp:number)=>({timestamp,open:100,high:100,low:100,close:100,volume:1})
  assert.throws(()=>validateHistory('BTC-USDT',[candle(cursor+60000),candle(cursor+180000)],plan),/Missing observed history/)
  assert.throws(()=>validateHistory('BTC-USDT',[candle(cursor+60000)],plan),/Incomplete observed history/)
  assert.throws(()=>planHistory(100,cursor+60000,cursor),/future history cursor/)
})

test('history backfills capped venue pages without duplicating or inventing bars',async()=>{
  const start=1700000040000
  const candles=Array.from({length:1600},(_,i)=>({time:start+i*60000,open:100,high:101,low:99,close:100,volume:1}))
  const calls:number[]=[]
  const source={async candles(_s:string,_i:string,limit:number,endTime?:number){calls.push(endTime!);return candles.filter(c=>c.time<=endTime!).slice(-Math.min(limit,1000)).reverse()}}
  const result=await closedHistory(source,'BTC-USDT',1440,start+1600*60000)
  assert.equal(result.length,1440);assert.equal(calls.length,2)
  assert.equal(result[0].timestamp,candles[160].time+60000)
  assert.equal(result.at(-1)!.timestamp,start+1600*60000)
  assert.equal(new Set(result.map(c=>c.timestamp)).size,1440)
})
test('a short listing stays explicitly short and an ignored cursor cannot loop forever',async()=>{
  const data=Array.from({length:10},(_,i)=>({time:1700000040000+i*60000,open:100,high:101,low:99,close:100,volume:1}))
  let calls=0
  const result=await closedHistory({async candles(){calls++;return data}},'BTC-USDT',1440,1700000640000)
  assert.equal(result.length,10);assert.ok(calls<=3)
})
