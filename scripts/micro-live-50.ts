/** Explicitly authorized x02-only, bounded automatic strategy observation with owned cleanup. */
import {mkdir,readFile,writeFile,appendFile,access} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {BingxVstClient} from '../core/bingx'
import {TerminalRuntime} from '../core/runtime'
import {StateStore} from '../core/store'
import {DemoExecutor} from '../core/executor'
import type {ExecutionIntent} from '../core/types'

const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
async function main(){
 if(!process.argv.includes('--execute'))throw Error('Pass --execute for the authorized VST run')
 const directory=resolve(arg('--output','.data/micro-live-50')),duration=Number(arg('--seconds','600')),symbolCount=Number(arg('--symbols','50'))
 if(!Number.isInteger(symbolCount)||symbolCount<1||symbolCount>50||!Number.isFinite(duration)||duration<=0||duration>1800)throw Error('Symbols must be1..50 and observation seconds1..1800')
 await mkdir(directory,{recursive:true,mode:0o700})
 const store=new StateStore(join(directory,'runtime.sqlite')),venue=new BingxVstClient(),runtime=new TerminalRuntime('bingx-x02',store)
 const initial={positions:await venue.positions(),orders:await venue.openOrders()}
 runtime.saveFlatSettings({symbolCount,historyCandles:1440,baseNotional:100,volumeFactor:.01,maxOrderNotional:Number(arg('--max-order-notional','10')),stageGateMode:'processed-sets',microMinSlDistancePct:.1,microMinTrailDistancePct:.05,strategyEnabledRanges:arg('--ranges','Micro,Low-Range').split(','),strategyTpSteps:[2,3,4,5,6,8,9,12],strategySlRatios:Array.from({length:15},(_,i)=>(i+2)/10),strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:arg('--indications','Trend').split(','),strategySignalTimeframes:[1/6,1],autoPfEnabled:true,autoPfRatio:.2,autoPfMax:2,microTradeStream:true,microTrailRatio:.5,axisPrevious:5,axisLast:2,axisOutcome:'positive',axisReferenceStage:'base',blockBehavior:'rounds',blockSize:3,blockSteps:3,blockVolumeRatio:.2,blockPauseRounds:1,blockMaxMultiplier:1.6,dcaDistancePct:.2,dcaMultiplier:.2})
 let runError:string|null=null,warmedAt:number|undefined,observationCompleted=false,stopRequested=false,observedSeconds=0
 try{
  const historyDirectory=arg('--history-directory','')
  if(historyDirectory){
   if(runtime.engine.managedSymbols().some(symbol=>runtime.engine.lastProcessedAt(symbol)!==null))throw Error('Offline profile preparation requires a fresh directory; resume the saved runtime without --history-directory')
   const manifest=JSON.parse(await readFile(join(historyDirectory,'manifest.json'),'utf8'))
   if(manifest.symbols.length!==symbolCount||manifest.barSeconds!==60)throw Error('The exact requested observed one-minute study is required')
   runtime.engine.updateSettings({symbols:manifest.symbols,symbolFees:Object.fromEntries(manifest.symbols.map((symbol:string)=>[symbol,{makerFeePct:manifest.fee.maker*100,takerFeePct:manifest.fee.taker*100}]))})
   for(const [index,symbol] of manifest.symbols.entries()){
    const raw=JSON.parse(await readFile(join(historyDirectory,`${symbol}.json`),'utf8')).slice(-1440)
    const bars=raw.map((c:any)=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}))
    await runtime.warmObservedHistory(symbol,bars)
    console.log(JSON.stringify({phase:'observed-history-prewarm',symbol,completed:index+1,total:symbolCount}))
   }
   // Each symbol is durably checkpointed. Startup still recovers every missing
   // native minute; cached observations never manufacture runtime freshness.
  }
  await runtime.start()
  const began=Date.now()
  while(Date.now()-began<1_800_000){
   await new Promise(r=>setTimeout(r,5000))
   const snapshot=await runtime.serial(async()=>runtime.snapshot())
   const coverage=runtime.control.warmed.length
   if(coverage===symbolCount)warmedAt??=Date.now()
   const observation={checkedAt:new Date().toISOString(),elapsedSeconds:(Date.now()-began)/1000,warmed:coverage,control:runtime.control,stages:runtime.engine.snapshot({laneLimit:0,positionLimit:0}).stages,stream:(snapshot as any).microMarketData,execution:new DemoExecutor(store,venue).summary(),performance:{heapBytes:process.memoryUsage().heapUsed,maxRssKiB:process.resourceUsage().maxRSS}}
   await appendFile(join(directory,'observations.ndjson'),JSON.stringify(observation)+'\n')
   await writeFile(join(directory,'latest.json'),JSON.stringify(observation))
   console.log(JSON.stringify({elapsed:observation.elapsedSeconds,warmed:coverage,stream:observation.stream,execution:observation.execution}))
   observedSeconds=warmedAt?(Date.now()-warmedAt)/1000:0
   if(warmedAt&&observedSeconds>=duration){observationCompleted=true;break}
   try{await access(join(directory,'stop'));stopRequested=true;break}catch{}
  }
  if(!observationCompleted&&!stopRequested)runError='Automatic observation reached its 30-minute cap before completing the full warmup and requested observation'
 }catch(e){runError=e instanceof Error?e.message:'Live observation failed'}
 finally{
  try{await runtime.quiesce()}catch(e){runError??=e instanceof Error?e.message:'Runtime stop could not be confirmed'}
  const executor=new DemoExecutor(store,venue,{connectionId:'bingx-x02',beforeSubmit:()=>runtime.assertOwnership()})
  let cleanupError:string|null=null
  try{
   for(let pass=0;pass<15;pass++){
    const closes:ExecutionIntent[]=executor.lots().filter(l=>l.quantity>1e-10).map(l=>({...l.executionIntent,id:`${l.executionIntent.id}-study-cleanup`,kind:'close',timestamp:Date.now(),requestedQuantity:l.quantity,status:'pending'}))
    await executor.process(closes)
    if(executor.lots().every(l=>l.quantity<=1e-10&&l.fees!==null))break
    await new Promise(r=>setTimeout(r,500))
   }
  }catch(e){cleanupError=e instanceof Error?e.message:'Owned cleanup incomplete'}
  const positions=await venue.positions(),orders=await venue.openOrders(),lots=executor.lots()
  const signature=(p:typeof positions,o:typeof orders)=>JSON.stringify({p:p.map(r=>[r.positionId,r.symbol,r.direction,r.quantity]).sort(),o:o.map(r=>r.orderId).sort()})
  const result={generatedAt:new Date().toISOString(),environment:'BingX VST',runError,cleanupError,observationCompleted,stopRequested,observedSeconds,warmedSymbols:runtime.control.warmed.length,initialPositionCount:initial.positions.length,initialOrderCount:initial.orders.length,finalPositionCount:positions.length,finalOrderCount:orders.length,foreignInventoryPreserved:signature(initial.positions,initial.orders)===signature(positions,orders),ownedOpenLots:lots.filter(l=>l.quantity>1e-10).length,accounting:executor.summary(),stages:runtime.engine.snapshot({laneLimit:0,positionLimit:0}).stages,coordinations:runtime.engine.coordinationStats(),settings:runtime.engine.settings,fees:runtime.engine.settings.symbolFees,tradeBarCoverage:runtime.engine.settings.symbols.map(symbol=>{const bars=store.tradeBars(symbol,100000);return {symbol,bars:bars.length,complete:bars.filter(b=>b.complete).length,first:bars[0]?.timestamp,last:bars.at(-1)?.timestamp}}),lots:lots.map(l=>({symbol:l.symbol,direction:l.direction,quantity:l.quantity,openedNotional:l.openedNotional,closedQuantity:l.closedQuantity,fees:l.fees,netPnl:l.realizedNetPnl,protection:l.protection})),scope:'Automatic strategy entries require genuine own-stage qualification. Minute historical warmup and recorded 10s streams are separate. All fills and signed commissions use owned order attribution. No synthetic evidence or forced positive qualification.'}
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2))
  await writeFile(join(directory,'trade-bars.json'),JSON.stringify(Object.fromEntries(runtime.engine.settings.symbols.map(symbol=>[symbol,store.tradeBars(symbol,100000)]))))
  runtime.shutdown();store.close()
  if(runError||cleanupError||result.ownedOpenLots)process.exitCode=1
 }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'VST study failed');process.exitCode=1})
