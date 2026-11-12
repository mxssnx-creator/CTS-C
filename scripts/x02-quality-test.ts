/** Explicit, bounded VST-only native validation. Never run against x01. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {BingxVstClient,demoCredentials,type BingxClient} from '../core/bingx'
import {DemoExecutor} from '../core/executor'
import {StateStore} from '../core/store'
import {TerminalRuntime} from '../core/runtime'
import {INDICATIONS} from '../core/indications'
import type {Candle,ExecutionIntent} from '../core/types'

async function main(){
const argv=process.argv.slice(2),arg=(name:string,fallback='')=>argv.includes(name)?(argv[argv.indexOf(name)+1]??fallback):fallback
if(!argv.includes('--execute'))throw Error('Native writes require the explicit --execute flag and dedicated x02 VST credentials')
const output=resolve(arg('--output')),market=resolve(arg('--data')),minutes=Number(arg('--minutes','10'))
if(!argv.includes('--output')||!argv.includes('--data')||minutes<1||minutes>30)throw Error('Supply fresh --output, frozen --data and --minutes 1..30')
if(existsSync(output))throw Error('Refusing to overwrite an existing native journal or its ownership fence')
const credentials=demoCredentials();if(!credentials)throw Error('Dedicated x02 credentials unavailable')
mkdirSync(output,{recursive:true,mode:0o700})
const write=(name:string,data:unknown)=>{const file=join(output,name);writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});renameSync(file+'.tmp',file)}
const log=(phase:string,data:unknown={})=>console.log(JSON.stringify({at:new Date().toISOString(),phase,...data as object}))
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
const client=new BingxVstClient(credentials),manifest=JSON.parse(readFileSync(join(market,'manifest.json'),'utf8')) as {symbols:string[];datasets:{symbol:string;file:string;sha256:string}[]}
if(manifest.symbols.length!==50||new Set(manifest.symbols).size!==50)throw Error('Exactly 50 distinct frozen symbols required')
const startedAt=Date.now(),baseline=await Promise.all([client.positions(),client.openOrders(),client.commission()])
write('baseline-private.json',{positions:baseline[0],orders:baseline[1],fees:baseline[2]})
log('read-only-baseline',{foreignPositions:baseline[0].length,foreignOrders:baseline[1].length})

async function diagnostic(){
 const store=new StateStore(join(output,'diagnostic.sqlite')),owner='ctsc-diagnostic-'+randomUUID()
 if(!store.acquireLease(owner))throw Error('Diagnostic journal is already owned')
 const guard=()=>{if(!store.renewLease(owner))throw Error('Diagnostic ownership lost')},heartbeat=setInterval(guard,2000)
 const executor=new DemoExecutor(store,client,{connectionId:'bingx-x02',beforeSubmit:guard}),records:unknown[]=[]
 let failure:unknown
 try{
  const [contracts,quotes,positions,orders]=await Promise.all([client.contracts(),client.quotes(),client.positions(),client.openOrders()])
  const prices=new Map(quotes.map(q=>[q.symbol,q.price])),blocked=new Set([...positions.map(p=>p.symbol),...orders.map(o=>o.symbol)])
  const contract=contracts.find(c=>manifest.symbols.includes(c.symbol)&&!blocked.has(c.symbol)&&prices.has(c.symbol)&&c.minNotional<=2&&c.minQuantity*(prices.get(c.symbol)??Infinity)*5<=20)
  if(!contract)throw Error('No empty eligible symbol for isolated exact-ratio diagnostics')
  for(const direction of ['long','short'] as const){
   const price=(await client.quotes()).find(q=>q.symbol===contract.symbol)!.price,id='diagnostic-'+randomUUID()
   const entry:ExecutionIntent={id:id+'-entry',connectionId:'bingx-x02',positionId:id,laneId:id,configId:'procedural-diagnostic',symbol:contract.symbol,direction,kind:'entry',requestedQuantity:contract.minQuantity,notional:contract.minQuantity*price,price,timestamp:Date.now(),takeProfitPct:2,stopLossPct:1,exitMode:'fixed',minimumAddRatio:.2,maxOrderNotional:25,source:'real-qualified',status:'pending'}
   const entryResult=await executor.process([entry]);records.push({phase:'entry',direction,result:entryResult})
   const lot=executor.lots().find(l=>l.executionIntent.positionId===id)
   if(!lot?.quantity||lot.protection!=='active'||!lot.leverage)throw Error('Diagnostic entry/protection/maximum leverage was not confirmed')
   log('diagnostic-entry',{symbol:contract.symbol,direction,leverage:lot.leverage,quantity:lot.quantity})
   const add={...entry,id:id+'-add',kind:'add' as const,requestedQuantity:entry.requestedQuantity*.2,timestamp:Date.now()}
   records.push({phase:'add',direction,result:await executor.process([add])})
   const added=executor.lots().find(l=>l.id===lot.id)!
   if(Math.abs(added.openedQuantity/lot.openedQuantity-1.2)>1e-8||added.protection!=='active')throw Error('Native 20% addition or resized protection was not exact')
   records.push({phase:'close',direction,result:await executor.process([{...entry,id:id+'-close',kind:'close',timestamp:Date.now()}])})
   for(let i=0;i<6;i++){await executor.process([]);if(executor.lots().every(l=>l.quantity===0&&l.fees!==null&&l.protection==='closed'))break;await delay(1000)}
   if(executor.lots().some(l=>l.quantity>1e-10||l.protection!=='closed'))throw Error('Diagnostic close or owned conditional cleanup incomplete')
  }
 }catch(e){failure=e}
 finally{
  // The serialized executor remains the only mutator. Touch exact owned lots only.
  for(const lot of executor.lots().filter(l=>l.quantity>1e-10)){try{await executor.process([{...lot.executionIntent,id:'diagnostic-cleanup-'+lot.id,kind:'close',timestamp:Date.now()}])}catch(e){records.push({phase:'cleanup-error',error:String(e)})}}
  try{await executor.process([])}catch(e){records.push({phase:'final-reconciliation-error',error:String(e)})}
  write('diagnostic.json',{startedAt,endedAt:Date.now(),environment:'BingX VST',purpose:'Procedural mechanics only; excluded from validated strategy PF',records,lots:executor.lots(),summary:executor.summary(),failure:failure?String(failure):null})
  clearInterval(heartbeat);store.releaseLease(owner);store.close()
 }
 if(failure)throw failure
 log('diagnostics-complete')
}

await diagnostic()
const selected=new Set(manifest.symbols)
const createClient=():BingxClient=>{const c=new BingxVstClient(credentials),quotes=c.quotes.bind(c);c.quotes=async()=> (await quotes()).filter(q=>selected.has(q.symbol));return c}
const store=new StateStore(join(output,'cts-c.sqlite')),runtime=new TerminalRuntime('bingx-x02',store,createClient)
let failure:unknown,maximumRss=0,observedFrom:number|null=null,lastSample=0,stopRequested=false
process.on('SIGTERM',()=>{stopRequested=true});process.on('SIGINT',()=>{stopRequested=true})
const observations:unknown[]=[]
function sample(final=false){
 const s=runtime.snapshot(),memory=process.memoryUsage();maximumRss=Math.max(maximumRss,memory.rss)
 const row={at:new Date().toISOString(),final,readiness:s.readiness,configurationCount:s.engine.catalogCount,symbolCount:s.engine.symbolCount,processedCandles:s.engine.processedCandles,stages:s.stages,coordinationStats:s.coordinationStats,microMarketData:s.microMarketData,execution:s.execution.summary,comparison:s.execution.comparison,memory:{rss:memory.rss,heapUsed:memory.heapUsed,maximumRss}}
 observations.push(row);write('observations.json',{environment:'BingX VST',startedAt,observedFrom,observations});log('native-observation',{status:s.readiness.status,warmed:s.readiness.warmedSymbols,owned:s.execution.summary.ownedLots,qualifiedClosed:s.execution.summary.validatedExecutionPF.closed,rssMiB:Math.round(memory.rss/1048576)})
 return s
}
try{
 runtime.saveFlatSettings({symbolCount:50,historyCandles:4320,stageGateMode:'processed-sets',liveEntryMode:'real-mirror',prevPosWindow:20,mainEvalPosCount:8,realEvalPosCount:8,baseProfitFactor:1.1,mainProfitFactor:1.1,realProfitFactor:1.1,baseNotional:100,volumeFactor:.001,maxOrderNotional:25,strategyIndicationTypes:[...INDICATIONS],strategyEnabledRanges:['Micro','Low-Range','Minimal','Short'],strategyTpSteps:[2,8,12],strategySlRatios:[1],strategyExitModes:['fixed','trailing','trailing-only'],strategySignalTimeframes:[1],signalsMaxWindowDrawdownPct:3,microTradeStream:true,variantBlockEnabled:true,variantDcaEnabled:true,axisPrevEnabled:true,blockBehavior:'rounds',blockSize:3,blockVolumeRatio:.2,blockPauseRounds:1,blockMaxMultiplier:3})
 runtime.engine.updateSettings({symbols:manifest.symbols})
 for(const d of manifest.datasets){
  if(stopRequested)throw Error('Stopped during offline preparation')
  const body=readFileSync(join(market,d.file),'utf8');if(createHash('sha256').update(body).digest('hex')!==d.sha256)throw Error('Frozen candle digest mismatch')
  const candles=JSON.parse(body) as Candle[]
  await runtime.warmObservedHistory(d.symbol,candles.slice(-4320));log('offline-warmup',{symbol:d.symbol,completed:runtime.engine.managedSymbols().indexOf(d.symbol)+1,total:50})
 }
 await runtime.start();log('native-started',{symbols:50,gates:'20/8/8, PF 1.1',mode:'processed-sets / Real-mirror'})
 const deadline=Date.now()+40*60000
 while(!stopRequested&&Date.now()<deadline){
  if(Date.now()-lastSample>=30000){const s=sample();lastSample=Date.now();if(s.readiness.warmedSymbols===50&&observedFrom===null)observedFrom=Date.now();if(s.readiness.engineStatus!=='running')throw Error('Runtime stopped unexpectedly: '+s.readiness.status)}
  if(observedFrom&&Date.now()-observedFrom>=minutes*60000)break
  await delay(1000)
 }
 if(!observedFrom)throw Error('All 50 symbols did not finish live warmup within the bounded run')
 if(stopRequested)throw Error('Native run interrupted; owned cleanup requested')
}catch(e){failure=e;log('native-failure',{error:String(e)})}
finally{
 await runtime.quiesce()
 const executor=new DemoExecutor(store,client,{connectionId:'bingx-x02',beforeSubmit:()=>runtime.assertOwnership()})
 const cleanup:unknown[]=[]
 for(const lot of executor.lots().filter(l=>l.quantity>1e-10)){
  try{cleanup.push(...await executor.process([{...lot.executionIntent,id:'bounded-test-end-'+lot.id,kind:'close',timestamp:Date.now()}]))}catch(e){cleanup.push({error:String(e),lot:lot.id})}
 }
 for(let i=0;i<6;i++){try{await executor.process([])}catch(e){cleanup.push({error:String(e)})}if(executor.lots().every(l=>l.quantity===0&&l.protection==='closed'&&l.fees!==null))break;await delay(1000)}
 if(executor.lots().some(l=>l.quantity>1e-10||l.protection!=='closed'))failure??=Error('Owned exposure or protection cleanup remains unresolved; retained journal requires reconciliation')
 const final=sample(true)
 write('native-final.json',{environment:'BingX VST',startedAt,endedAt:Date.now(),observationMinutes:observedFrom?(Date.now()-observedFrom)/60000:0,maximumRss,failure:failure?String(failure):null,cleanupReason:'Bounded test end; owned exchange lots only. Forced exits are labeled procedural and can precede simulated exit.',cleanup,summary:executor.summary(),comparison:executor.comparison(),lots:executor.lots(),stages:final.stages,coordinationStats:final.coordinationStats,foreignBaseline:{positions:baseline[0].length,orders:baseline[1].length},leveragePolicy:'Maximum verified per symbol/direction; no quantity or return multiplier',gates:{lastN:[20,8,8],minPF:1.1},symbolCount:50})
 runtime.shutdown();store.close()
}
if(failure){console.error(String(failure));process.exitCode=1}else log('native-test-complete')
}
void main().catch(error=>{console.error(String(error));process.exitCode=1})
