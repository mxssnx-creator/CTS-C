import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fork} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'

test('bounded simulation worker preserves each trade, hourly totals and sample denominators without exchange credentials',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ctsc-simulation-worker-')),bars=Array.from({length:160},(_,i)=>{const close=100+5*Math.sin(i/9);return {timestamp:1700000040000+i*60000,open:close,high:close,low:close,close,volume:1}}),body=JSON.stringify(bars)
 await writeFile(join(directory,'BTC-USDT.json'),body)
 const child=fork(resolve('scripts/simulation-50.ts'),['--worker'],{execArgv:['--import','tsx','--max-old-space-size=640'],stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,NODE_ENV:'test',TZ:'UTC'}})
 let errors='';child.stderr!.on('data',b=>errors+=b)
 try{
  const result=await new Promise<any>((resolveJob,reject)=>{
   const timer=setTimeout(()=>reject(Error('Simulation fixture worker timed out: '+errors)),45000)
   child.once('error',e=>{clearTimeout(timer);reject(e)})
   child.once('exit',(code,signal)=>{clearTimeout(timer);reject(Error('Simulation fixture exited: '+code+'/'+signal+' '+errors))})
   child.once('message',(message:any)=>{clearTimeout(timer);if(message.error)reject(Error(message.error));else resolveJob(message.result)})
   child.send({id:'synthetic-fixture',symbol:'BTC-USDT',type:'Trend',root:directory,output:directory,dataset:{symbol:'BTC-USDT',file:'BTC-USDT.json',bars:160,sha256:createHash('sha256').update(body).digest('hex')},settings:{sourceHash:'synthetic-fixture',warmup:100,hours:1,fees:{makerFeePct:.02,takerFeePct:.05},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategySignalPeriods:[20],strategySignalTimeframes:[1]}}})
  })
  assert.equal(result.results.length,4);assert.equal(result.configurations,1)
  for(const profile of result.results){
   let lines=gunzipSync(await readFile(join(directory,'trades','BTC-USDT','Trend',profile.profile.replace('prehistory-selected-','')+'.ndjson.gz'))).toString().trim().split('\n').map(s=>JSON.parse(s)),header=lines.shift()!
   assert.equal(header.ordersSubmitted,0);assert.equal(header.sourceHash,'synthetic-fixture');if(profile.frozenPrehistory){const ids=new Set(header.prehistorySelectedIds);lines=lines.filter(t=>ids.has(t.configId))}
   for(const stage of ['base','main','real','live']){
    const trades=lines.filter(t=>t.stage===stage),totals=profile.totals[stage],hour=profile.hourly[0]
    assert.equal(trades.length,totals.closes);assert.deepEqual(hour.stages[stage],totals)
    assert.ok(hour.coverage[stage].enough<=hour.coverage[stage].sets)
    assert.ok(Math.abs(trades.reduce((n,t)=>n+Math.max(0,t.netReturnPct),0)-totals.profit)<1e-10)
    assert.ok(Math.abs(trades.reduce((n,t)=>n+Math.max(0,-t.netReturnPct),0)-totals.loss)<1e-10)
    for(const t of trades)assert.ok(Math.abs(t.grossPnl-t.cost-t.netPnl)<1e-10)
   }
  }
  assert.ok(result.results[0].totals.base.closes>0)
  assert.deepEqual(result.results[0].totals.base,result.results[2].totals.base)
 }finally{child.disconnect();child.kill('SIGTERM');await rm(directory,{recursive:true,force:true})}
})
