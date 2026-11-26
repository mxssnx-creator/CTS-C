/** Explicit, bounded VST-only native validation. Never run against x01. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {BingxVstClient,demoCredentials,type BingxClient,type ClientOptions,type VenueOrder,type VenuePosition} from '../core/bingx'
import {DemoExecutor} from '../core/executor'
import {StateStore} from '../core/store'
import {TerminalRuntime} from '../core/runtime'
import {INDICATIONS} from '../core/indications'
import {describeProfitFactor} from '../core/metrics'
import type {Candle,ExecutionIntent} from '../core/types'

const inventory = (positions:VenuePosition[],orders:VenueOrder[]) => JSON.stringify({
  positions:positions.map(p=>[p.positionId,p.symbol,p.direction,p.quantity]).sort(),
  orders:orders.map(o=>o.orderId).sort(),
})
const percentile = (series:readonly number[],p:number) =>
  series.length ? [...series].sort((a,b)=>a-b)[Math.ceil(series.length*p)-1] : null
const delay = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms))
const venueOrderId = (row:ReturnType<StateStore['intents']>[number]) => {
  const result=row.result as {outcome?:{status?:string;order?:VenueOrder}}|undefined
  return result?.outcome?.status==='accepted'?result.outcome.order?.orderId:undefined
}

async function retryRateLimitedRead<T>(read:()=>Promise<T>):Promise<T>{
  for(let attempt=1;;attempt++){
    try{return await read()}
    catch(error){
      const code=(error as {code?:string}|null)?.code
      if(!['429','100410','100429'].includes(code??'')||attempt===4)throw error
      const retryAt=(error as {retryAt?:number}).retryAt??0
      await delay(Math.max(30_000*attempt,retryAt-Date.now()))
    }
  }
}

async function main(){
const argv=process.argv.slice(2),arg=(name:string,fallback='')=>argv.includes(name)?(argv[argv.indexOf(name)+1]??fallback):fallback
if(!argv.includes('--execute'))throw Error('Native writes require the explicit --execute flag and dedicated x02 VST credentials')
const output=resolve(arg('--output')),market=resolve(arg('--data')),minutes=Number(arg('--minutes','10'))
const symbolCount=Number(arg('--symbols','50')),historyCandles=Number(arg('--history','4320'))
const flat=arg('--settings')?JSON.parse(readFileSync(resolve(arg('--settings')),'utf8')) as Record<string,unknown>:null
if(!argv.includes('--output')||!argv.includes('--data')||!Number.isInteger(minutes)||minutes<1||minutes>60||
   !Number.isInteger(symbolCount)||symbolCount<1||symbolCount>500||!Number.isInteger(historyCandles)||historyCandles<100||historyCandles>20_160)
  throw Error('Supply fresh --output, frozen --data, --minutes 1..60, --symbols 1..500 and --history 100..20160')
if(existsSync(output))throw Error('Refusing to overwrite an existing native journal or its ownership fence')
const credentials=demoCredentials();if(!credentials)throw Error('Dedicated x02 credentials unavailable')
mkdirSync(output,{recursive:true,mode:0o700})
const write=(name:string,data:unknown)=>{const file=join(output,name);writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});renameSync(file+'.tmp',file)}
const log=(phase:string,data:unknown={})=>console.log(JSON.stringify({at:new Date().toISOString(),phase,...data as object}))
const client=new BingxVstClient(credentials,{pacePublicMarket:true}),tapes=JSON.parse(readFileSync(join(market,'manifest.json'),'utf8')) as {symbols:string[];datasets:{symbol:string;file:string;sha256:string}[]}
if(tapes.symbols.length<symbolCount||new Set(tapes.symbols).size!==tapes.symbols.length||
   tapes.datasets.length!==tapes.symbols.length||new Set(tapes.datasets.map(d=>d.symbol)).size!==tapes.datasets.length||
   tapes.datasets.some(d=>!tapes.symbols.includes(d.symbol)||d.file!==d.symbol+'.json'))
  throw Error('A distinct frozen tape is required for each candidate symbol')
const startedAt=Date.now(),baseline=await retryRateLimitedRead(()=>Promise.all([client.positions(),client.openOrders(),client.commission(),client.positionMode()]))
if(baseline[3]!=='hedge')throw Error('The x02 test requires hedge mode')
const occupied=new Set([...baseline[0],...baseline[1]].map(row=>row.symbol))
const symbols=tapes.symbols.filter(symbol=>!occupied.has(symbol)).slice(0,symbolCount)
if(symbols.length!==symbolCount)throw Error('Insufficient frozen symbols free of existing demo positions and orders')
const manifest={symbols,datasets:tapes.datasets.filter(d=>symbols.includes(d.symbol))}
write('baseline-private.json',{positions:baseline[0],orders:baseline[1],fees:baseline[2]})
log('read-only-baseline',{foreignPositions:baseline[0].length,foreignOrders:baseline[1].length})

async function diagnostic(){
 const store=new StateStore(join(output,'diagnostic.sqlite')),owner='ctsc-diagnostic-'+randomUUID()
 if(!store.acquireLease(owner))throw Error('Diagnostic journal is already owned')
 const guard=()=>{if(!store.renewLease(owner))throw Error('Diagnostic ownership lost')},heartbeat=setInterval(guard,2000)
 const executor=new DemoExecutor(store,client,{connectionId:'bingx-x02',beforeSubmit:guard}),records:unknown[]=[]
 let failure:unknown
 async function drive(intent:ExecutionIntent){
   const began=performance.now()
   for(let attempt=0;attempt<14;attempt++){
     const row=(await executor.process([intent],attempt>0)).find(update=>update.id===intent.id)
     if(row?.status==='acknowledged'){
       records.push({kind:intent.kind,direction:intent.direction,confirmationMs:performance.now()-began,attempts:attempt+1})
       return
     }
     if(row?.status==='rejected')throw Error(`x02 ${intent.kind} rejected: ${row.error}`)
     await delay(300)
   }
   throw Error(`x02 ${intent.kind} awaits reconciliation`)
 }
 try{
  const [contracts,quotes,positions,orders]=await Promise.all([client.contracts(),client.quotes(),client.positions(),client.openOrders()])
  const prices=new Map(quotes.map(q=>[q.symbol,q.price])),blocked=new Set([...positions.map(p=>p.symbol),...orders.map(o=>o.symbol)])
  const selectedContract=contracts.find(c=>{
    const price=prices.get(c.symbol)
    if(!manifest.symbols.includes(c.symbol)||blocked.has(c.symbol)||!price)return false
    const quantum=5*10**-c.quantityPrecision
    const rounded=Math.ceil(5.5*Math.max(c.minQuantity,c.minNotional/price)/quantum)*quantum
    return rounded*price<=20
  })
  if(!selectedContract)throw Error('No empty eligible symbol for isolated exact-ratio diagnostics')
  const contract=selectedContract
  for(const direction of ['long','short'] as const){
   const price=(await client.quotes()).find(q=>q.symbol===contract.symbol)!.price,id='diagnostic-'+randomUUID()
   const size=5.5*Math.max(contract.minQuantity,contract.minNotional/price)
   const entry:ExecutionIntent={id:id+'-entry',connectionId:'bingx-x02',positionId:id,laneId:id,configId:'procedural-diagnostic',symbol:contract.symbol,direction,kind:'entry',requestedQuantity:size,notional:size*price,price,timestamp:Date.now(),takeProfitPct:2,stopLossPct:1,exitMode:'fixed',minimumAddRatio:.2,maxOrderNotional:25,source:'real-qualified',status:'pending'}
   async function verifyProtection(positionId:string){
     const lot=executor.lots().find(l=>l.executionIntent.positionId===positionId)
     if(!lot?.quantity||lot.protection!=='active')throw Error('No active protection for the native diagnostic lot')
     const signed=direction==='long'?1:-1
     const coerce=(pct:number)=>Number((lot.averageEntry*(1+signed*pct/100)).toFixed(contract.pricePrecision))
     const expected=new Map([['STOP_MARKET',coerce(-entry.stopLossPct)],['TAKE_PROFIT_MARKET',coerce(entry.takeProfitPct)]])
     const owned=new Set(store.openExecutionIntents().flatMap(row=>{
       const p=row.payload as {role?:string;intent?:ExecutionIntent}
       const venueId=venueOrderId(row)
       return p.role==='protection'&&p.intent?.positionId===positionId&&venueId?[venueId]:[]
     }))
     const open=(await client.openOrders(contract.symbol)).filter(order=>owned.has(order.orderId))
     if(open.length!==2||open.some(order=>order.stopPrice!==expected.get(order.type)||Math.abs(order.quantity-lot.quantity)>1e-9||!expected.delete(order.type)))
       throw Error('Native control price, size or ownership differs from the filled lot')
     return lot
   }
   await drive(entry)
   const lot=executor.lots().find(l=>l.executionIntent.positionId===id)
   if(!lot?.quantity||lot.protection!=='active'||!lot.leverage)throw Error('Diagnostic entry/protection/maximum leverage was not confirmed')
   await verifyProtection(id)
   log('diagnostic-entry',{symbol:contract.symbol,direction,leverage:lot.leverage,quantity:lot.quantity})
   const add={...entry,id:id+'-add',kind:'add' as const,requestedQuantity:entry.requestedQuantity*.2,timestamp:Date.now()}
   await drive(add)
   const added=await verifyProtection(id)
   if(Math.abs(added.openedQuantity/lot.openedQuantity-1.2)>1e-8||added.protection!=='active')throw Error('Native 20% addition or resized protection was not exact')
   const second={...entry,id:id+'-second-entry',positionId:id+'-second',laneId:id+'-second',timestamp:Date.now()}
   await drive(second)
   const sibling=await verifyProtection(second.positionId)
   await drive({...entry,id:id+'-close',kind:'close',timestamp:Date.now()})
   const residual=(await client.positions(contract.symbol)).find(p=>p.direction.toLowerCase()===direction)
   if(!residual||Math.abs(residual.quantity-sibling.quantity)>1e-9)throw Error('Partial native close did not preserve the sibling lot quantity')
   await verifyProtection(second.positionId)
   records.push({phase:'partial-position-verified',direction,closedQuantity:added.quantity,remainingQuantity:sibling.quantity})
   await drive({...second,id:id+'-second-close',kind:'close',timestamp:Date.now()})
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
const submissions:number[]=[], confirmAfterIntent:number[]=[]
const createClient=(_id:string,options?:ClientOptions):BingxClient=>{
  const c=new BingxVstClient(credentials,options),quotes=c.quotes.bind(c),submit=c.submitOrder.bind(c)
  c.quotes=async()=> (await quotes()).filter(q=>selected.has(q.symbol))
  c.submitOrder=async(...input)=>{
    const begin=performance.now()
    try { return await submit(...input) } finally { submissions.push(performance.now()-begin) }
  }
  return c
}
const store=new StateStore(join(output,'cts-c.sqlite')),runtime=new TerminalRuntime('bingx-x02',store,createClient)
const eventLoop=monitorEventLoopDelay({resolution:20})
let failure:unknown,maximumRss=0,observedFrom:number|null=null,observedMonotonic:number|null=null,elapsedMinutes=0,lastSample=0,stopRequested=false
let maximumTickLag=0,maximumProtectionGaps=0
const observedPaper={closes:0,profit:0,loss:0,cashProfit:0,cashLoss:0}
runtime.engine.observeStageCloses(trade=>{
 if(!trade.executed||observedFrom===null||trade.openedAt<observedFrom)return
 observedPaper.closes++
 observedPaper.profit+=Math.max(0,trade.netReturnPct)
 observedPaper.loss+=Math.max(0,-trade.netReturnPct)
 observedPaper.cashProfit+=Math.max(0,trade.netPnl)
 observedPaper.cashLoss+=Math.max(0,-trade.netPnl)
})
process.on('SIGTERM',()=>{stopRequested=true});process.on('SIGINT',()=>{stopRequested=true})
const observations:unknown[]=[]
function sample(final=false){
 const s=runtime.snapshot(),memory=process.memoryUsage();maximumRss=Math.max(maximumRss,memory.rss)
 const tickLag=runtime.control.lastTick===null?null:Date.now()-runtime.control.lastTick
 if(observedFrom!==null&&tickLag!==null)maximumTickLag=Math.max(maximumTickLag,tickLag)
 maximumProtectionGaps=Math.max(maximumProtectionGaps,s.execution.summary.protectionGaps)
 const timing={eventLoopP95Ms:eventLoop.percentile(95)/1e6,eventLoopMaxMs:eventLoop.max/1e6,submitCount:submissions.length,submitP95Ms:percentile(submissions,.95),tickLag}
 const row={at:new Date().toISOString(),final,readiness:s.readiness,configurationCount:s.engine.catalogCount,symbolCount:s.engine.symbolCount,processedCandles:s.engine.processedCandles,stages:s.stages,coordinationStats:s.coordinationStats,microMarketData:s.microMarketData,execution:s.execution.summary,comparison:s.execution.comparison,timing,memory:{rss:memory.rss,heapUsed:memory.heapUsed,maximumRss}}
 observations.push(row);write('observations.json',{environment:'BingX VST',startedAt,observedFrom,observations});log('native-observation',{status:s.readiness.status,warmed:s.readiness.warmedSymbols,owned:s.execution.summary.ownedLots,qualifiedClosed:s.execution.summary.validatedExecutionPF.closed,matched:s.execution.comparison.matched,rssMiB:Math.round(memory.rss/1048576),timing})
 return s
}
try{
 const settings=flat??{stageGateMode:'processed-sets',liveEntryMode:'real-mirror',prevPosWindow:20,mainEvalPosCount:8,realEvalPosCount:8,baseProfitFactor:1.1,mainProfitFactor:1.1,realProfitFactor:1.1,baseNotional:100,volumeFactor:.001,maxOrderNotional:25,strategyIndicationTypes:[...INDICATIONS],strategyEnabledRanges:['Micro','Low-Range','Minimal','Short'],strategyTpSteps:[2,8,12],strategySlRatios:[1],strategyExitModes:['fixed','trailing','trailing-only'],strategySignalTimeframes:[1],signalsMaxWindowDrawdownPct:3,microTradeStream:true,variantBlockEnabled:true,variantDcaEnabled:true,axisPrevEnabled:true,blockBehavior:'rounds',blockSize:3,blockVolumeRatio:.2,blockPauseRounds:1,blockMaxMultiplier:3}
 if(flat&&settings.stageGateMode!=='exec-branches')throw Error('A supplied x02 strategy settings file must use Exec branches')
 runtime.saveFlatSettings({...settings,symbolCount,historyCandles,maxOrderNotional:Math.min(25,Number(settings.maxOrderNotional)||25)})
 const {maker,taker}=baseline[2]
 runtime.engine.updateSettings({symbols:manifest.symbols,symbolFees:Object.fromEntries(manifest.symbols.map(symbol=>[symbol,{makerFeePct:Math.max(0,maker*100),takerFeePct:taker*100}]))})
 for(const d of manifest.datasets){
  if(stopRequested)throw Error('Stopped during offline preparation')
  const body=readFileSync(join(market,d.file),'utf8');if(createHash('sha256').update(body).digest('hex')!==d.sha256)throw Error('Frozen candle digest mismatch')
  const candles=JSON.parse(body) as Candle[]
  if(candles.length<historyCandles)throw Error('Frozen VST history is shorter than requested')
  const began=performance.now()
  await runtime.warmObservedHistory(d.symbol,candles.slice(-historyCandles))
  log('offline-warmup',{symbol:d.symbol,completed:runtime.engine.managedSymbols().indexOf(d.symbol)+1,total:symbolCount,durationMs:Math.round(performance.now()-began),rssMiB:Math.round(process.memoryUsage.rss()/2**20)})
 }
 await retryRateLimitedRead(()=>runtime.start({symbols:manifest.symbols}));eventLoop.enable();log('native-started',{symbols:symbolCount,mode:runtime.engine.settings.stageGateMode})
 const warmDeadline=performance.now()+40*60000
 while(!stopRequested){
  if(Date.now()-lastSample>=30000){
    const s=sample();lastSample=Date.now()
    if(s.readiness.warmedSymbols===symbolCount&&observedFrom===null){observedFrom=Date.now();observedMonotonic=performance.now();log('observation-started',{symbols:symbolCount,minutes})}
    if(s.readiness.engineStatus!=='running')throw Error('Runtime stopped unexpectedly: '+s.readiness.status)
  }
  if(observedMonotonic!==null&&performance.now()-observedMonotonic>=minutes*60000)break
  if(observedMonotonic===null&&performance.now()>=warmDeadline)throw Error(`All ${symbolCount} symbols did not finish live warmup`)
  await delay(1000)
 }
 if(stopRequested)throw Error('Native run interrupted; owned cleanup requested')
}catch(e){failure=e;log('native-failure',{error:String(e)})}
finally{
 if(observedMonotonic!==null)elapsedMinutes=(performance.now()-observedMonotonic)/60_000
 try{await runtime.quiesce()}catch(e){failure??=e}
 const observed=runtime.snapshot().execution
 const executor=new DemoExecutor(store,client,{connectionId:'bingx-x02',beforeSubmit:()=>runtime.assertOwnership()})
 const cleanup:unknown[]=[]
 for(const lot of executor.lots().filter(l=>l.quantity>1e-10)){
  try{cleanup.push(...await executor.process([{...lot.executionIntent,id:'bounded-test-end-'+lot.id,kind:'close',timestamp:Date.now()}]))}catch(e){cleanup.push({error:String(e),lot:lot.id})}
 }
 for(let i=0;i<6;i++){try{await executor.process([])}catch(e){cleanup.push({error:String(e)})}if(executor.lots().every(l=>l.quantity===0&&l.protection==='closed'&&l.fees!==null))break;await delay(1000)}
 if(executor.lots().some(l=>l.quantity>1e-10||l.protection!=='closed'))failure??=Error('Owned exposure or protection cleanup remains unresolved; retained journal requires reconciliation')
 let inventoryVerified=false,foreignInventoryUnchanged=false
 try{
  const [positions,orders]=await Promise.all([client.positions(),client.openOrders()])
  const ids=new Set(store.openExecutionIntents().map(venueOrderId)),unresolved=store.unresolvedIntents()
  inventoryVerified=unresolved.length===0&&executor.lots().every(lot=>lot.quantity<=1e-10&&lot.protection==='closed')&&!orders.some(order=>ids.has(order.orderId))
  foreignInventoryUnchanged=inventory(positions,orders)===inventory(baseline[0],baseline[1])
  if(!inventoryVerified)failure??=Error('Exact owned inventory could not be verified at the venue')
 }catch(e){failure??=e}
 for(const row of store.openExecutionIntents()){
  const p=row.payload as {role?:string;intent?:ExecutionIntent}
  const r=row.result as {outcome?:{status?:string;order?:VenueOrder}}|undefined
  const received=r?.outcome?.order
  if(!p.role&&p.intent&&!p.intent.id.startsWith('bounded-test-end-')&&received&&r?.outcome?.status==='accepted'&&received.updateTime>=p.intent.timestamp&&received.updateTime-p.intent.timestamp<60_000)
    confirmAfterIntent.push(received.updateTime-p.intent.timestamp)
 }
 const final=sample(true)
 const paper={...observedPaper,returns:describeProfitFactor(observedPaper.profit,observedPaper.loss,observedPaper.closes),cash:describeProfitFactor(observedPaper.cashProfit,observedPaper.cashLoss,observedPaper.closes)}
 write('native-final.json',{environment:'BingX VST',startedAt,endedAt:Date.now(),observationMinutes:elapsedMinutes,maximumRss,failure:failure?String(failure):null,cleanupReason:'Bounded test end; owned exchange lots only. Forced exits are labeled procedural and can precede simulated exit.',cleanup,summary:final.execution.summary,comparison:executor.comparison(),observed:{paper,summary:observed.summary,comparison:observed.comparison},lots:executor.lots(),stages:final.stages,coordinationStats:final.coordinationStats,foreignBaseline:{positions:baseline[0].length,orders:baseline[1].length},inventoryVerified,foreignInventoryUnchanged,leveragePolicy:'Maximum verified per symbol/direction; no quantity or return multiplier',symbolCount,symbols:manifest.symbols,historyCandles,maximumProtectionGaps,maximumTickLag,timing:{p95Ms:eventLoop.percentile(95)/1e6,maxEventLoopMs:eventLoop.max/1e6,submitCount:submissions.length,submitP95Ms:percentile(submissions,.95),confirmSamples:confirmAfterIntent.length,confirmP95Ms:percentile(confirmAfterIntent,.95)}})
 eventLoop.disable();runtime.shutdown();store.close()
}
if(failure){console.error(String(failure));process.exitCode=1}else log('native-test-complete')
}
void main().catch(error=>{console.error(String(error));process.exitCode=1})
