import assert from 'node:assert/strict'
import {test} from 'node:test'
import {closedHistory,resumeHistoryCount} from '../core/history'

test('restart history uses retained cursors without dropping the unseen closed tail',async()=>{
  const start=1700000040000,now=start+1600*60000
  assert.equal(resumeHistoryCount(1440,null,now),1440)
  assert.equal(resumeHistoryCount(1440,now-3*60000,now),100)
  assert.equal(resumeHistoryCount(1440,now-200*60000,now),201)
  assert.equal(resumeHistoryCount(1440,now-2000*60000,now),1440)
  assert.equal(resumeHistoryCount(100,now-200*60000,now),100)
  const cursor=now-200*60000
  const candles=Array.from({length:1600},(_,i)=>({time:start+i*60000,open:100,high:101,low:99,close:100,volume:1}))
  let requests=0
  const result=await closedHistory({async candles(_s,_i,limit,endTime){requests++;return candles.filter(c=>c.time<=endTime!).slice(-limit)}},'BTC-USDT',resumeHistoryCount(1440,cursor,now),now)
  assert.equal(requests,1)
  assert.equal(result.filter(c=>c.timestamp>cursor).length,200)
  assert.equal(result.at(-1)?.timestamp,now)
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
