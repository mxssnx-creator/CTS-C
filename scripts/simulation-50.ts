/** Bounded, resumable observed-market replay. Workers never construct a private exchange client. */
import {fork,type ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {once} from 'node:events'
import {pipeline} from 'node:stream/promises'
import {createGzip} from 'node:zlib'
import {BingxVstClient,BINGX_VST_HOST} from '../core/bingx'
import {TradingEngine,validateObservedCandles,STAGES} from '../core/engine'
import {generateStrategyCatalog} from '../core/catalog'
import {INDICATIONS} from '../core/indications'
import {describeProfitFactor} from '../core/metrics'
import type {Candle,EngineEvent,StrategyConfig,Stage} from '../core/types'

const arg=(name:string,fallback?:string)=>{const at=process.argv.indexOf(name);if(at>=0&&process.argv[at+1])return process.argv[at+1];if(fallback!==undefined)return fallback;throw Error('Provide '+name)}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const empty=()=>({closes:0,wins:0,profit:0,loss:0,netPnl:0,cost:0,notional:0,entries:0,additions:0})
type Totals=ReturnType<typeof empty>
const totalKeys=Object.keys(empty()) as (keyof Totals)[]
const add=(a:Totals,b:Totals)=>{for(const k of totalKeys)a[k]+=b[k]}
const measured=(a:Totals)=>({...a,...describeProfitFactor(a.profit,a.loss,a.closes),modeledOrderActions:a.entries+a.additions+a.closes})
const coverageEmpty=()=>({sets:0,enough:0,qualified:0,admissionReady:0,validatedSamples:0,validatedSets:0,validatedProfit:0,validatedLoss:0,unfinished:0})
type Coverage=ReturnType<typeof coverageEmpty>
const addCoverage=(a:Coverage,b:Coverage)=>{for(const k of Object.keys(a) as (keyof Coverage)[])a[k]+=b[k]}
const safeName=(s:string)=>s.replace(/[^a-zA-Z0-9_.-]/g,'_')
const profiles=[{name:'original-20-8-8',real:8,liveEntryMode:'independent' as const},{name:'capacity-20-8-1',real:1,liveEntryMode:'real-mirror' as const}]
const dimensions=['symbol','type','range','coordination','direction','exitMode','tpStep','slRatio','source'] as const
type Dimension=typeof dimensions[number]
type Settings={sourceHash:string;warmup:number;hours:number;fees:{makerFeePct:number;takerFeePct:number};catalog:Record<string,unknown>}
type Manifest={cutoff:number;start:number;symbols:string[];datasets:{symbol:string;file:string;sha256:string;bars:number}[];excluded:{symbol:string;reason:string}[]}
type Job={id:string;symbol:string;type:string;root:string;output:string;settings:Settings;dataset:Manifest['datasets'][number]}
async function atomic(path:string,value:unknown){const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2));await rename(tmp,path)}

async function sourceDigest(){const manifest=JSON.parse(await readFile('shared/cts-indications/source-manifest.json','utf8'));const files=['core/engine.ts','core/catalog.ts','core/replay.ts','core/metrics.ts','core/exits.ts','core/technical-signals.ts','core/strategy-processing.ts','shared/cts-volume/ratios.ts','shared/cts-indications/index.ts','shared/cts-indications/catalog.ts','shared/cts-indications/source-manifest.json','scripts/simulation-50.ts',...Object.keys(manifest.sha256).map(p=>'shared/cts-indications/origin/'+p)];return hash((await Promise.all(files.map(async p=>p+'\n'+await readFile(resolve(p),'utf8')))).join('\n'))}
async function prepare(root:string,count:number,warmup:number,hours:number):Promise<Manifest>{
 await mkdir(root,{recursive:true})
 try{const previous=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) as Manifest;if(previous.symbols.length!==count||previous.datasets.some(d=>d.bars!==warmup+hours*60))throw Error('Existing market manifest has different dimensions');return previous}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 const clock=await (await fetch(BINGX_VST_HOST+'/openApi/swap/v2/server/time',{signal:AbortSignal.timeout(30000)})).json(),cutoff=Math.floor(Number(clock.data.serverTime)/60000)*60000
 if(!Number.isSafeInteger(cutoff)||cutoff<=0)throw Error('Market server time unavailable')
 const client=new BingxVstClient(null,{timeoutMs:30000}),[contracts,quotes]=await Promise.all([client.contracts(),client.quotes()])
 const available=new Set(quotes.filter(q=>q.price>0).map(q=>q.symbol)),priority=['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','BCH-USDT','DOGE-USDT']
 const candidates=[...new Set([...priority,...contracts.map(c=>c.symbol)])].filter(s=>available.has(s)),start=cutoff-(warmup+hours*60)*60000
 const result:Manifest={cutoff,start,symbols:[],datasets:[],excluded:[]};let next=0
 // Public requests are bounded; only absent history can exclude a symbol, never its P&L.
 while(result.datasets.length<count){
  const group=candidates.slice(next,next+Math.min(4,count-result.datasets.length));next+=group.length;if(!group.length)throw Error('Fewer than requested symbols have complete observed history')
  const reads=await Promise.allSettled(group.map(async symbol=>{
   const data=new Map<number,Candle>();let end=cutoff-1
   for(let page=0;page<Math.ceil((warmup+hours*60)/1000)+1;page++){
    let batch:Awaited<ReturnType<BingxVstClient['candles']>>|undefined
    for(let attempt=0;attempt<3;attempt++){try{batch=await client.candles(symbol,'1m',1000,end);break}catch(e){if(attempt===2)throw e}}
    if(!batch?.length)break
    for(const b of batch)if(b.time>=start&&b.time+60000<=cutoff)data.set(b.time,{timestamp:b.time+60000,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume})
    const oldest=Math.min(...batch.map(b=>b.time));if(oldest<=start||oldest>=end)break;end=oldest-1
   }
   const rows=[...data.values()].sort((a,b)=>a.timestamp-b.timestamp);validateObservedCandles(rows)
   if(rows.length!==warmup+hours*60||rows.some((b,i)=>b.timestamp!==start+(i+1)*60000))throw Error('Incomplete observed history')
   const body=JSON.stringify(rows),file=symbol+'.json';await writeFile(join(root,file),body)
   return {symbol,file,sha256:hash(body),bars:rows.length}
  }))
  for(let i=0;i<reads.length;i++){const r=reads[i];if(r.status==='fulfilled'){result.datasets.push(r.value);result.symbols.push(r.value.symbol)}else if(r.reason instanceof Error&&r.reason.message==='Incomplete observed history')result.excluded.push({symbol:group[i],reason:r.reason.message});else throw r.reason}
  console.log(JSON.stringify({phase:'market-history',complete:result.datasets.length,requested:count,excluded:result.excluded.length,cutoff:new Date(cutoff).toISOString()}))
 }
 await atomic(join(root,'manifest.json'),result);return result
}

async function runJob(job:Job){
 const started=performance.now(),raw=await readFile(join(job.root,job.dataset.file),'utf8');if(hash(raw)!==job.dataset.sha256)throw Error('Observed dataset digest mismatch')
 const bars=JSON.parse(raw) as Candle[];validateObservedCandles(bars)
 const catalog={...job.settings.catalog,...job.settings.fees,strategyIndicationTypes:[job.type]},configs=generateStrategyCatalog('bingx-x02',catalog),byId=new Map(configs.map(c=>[c.id,c])),results=[]
 for(const profile of profiles){
  let engine=new TradingEngine({symbols:[job.symbol],catalog,stageGateMode:'continuous-ancestors',liveEntryMode:profile.liveEntryMode,stageLastN:{base:20,main:8,real:profile.real},stageMinPF:{base:1.1,main:1.1,real:1.1}})
  engine.processCandles(job.symbol,bars.slice(0,job.settings.warmup),{eventLimit:0})
  const trained=engine.exportState();for(const lane of Object.values(trained.lanes))delete lane.open
  engine=TradingEngine.fromOwnedCheckpoint(trained)
  const totals=Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,groups=new Map<string,Totals>(),strategies=new Map<string,Totals>(),strategyCoverage=new Map<string,{sets:number;enough:number}>(),hourly:any[]=[],coverageGroups=new Map<string,{sets:number;enough:number}>()
  const folder=join(job.output,'trades',safeName(job.symbol),safeName(job.type));await mkdir(folder,{recursive:true})
  const stream=createGzip({level:6}),done=pipeline(stream,createWriteStream(join(folder,profile.name+'.ndjson.gz')));void done.catch(()=>{})
  stream.write(JSON.stringify({kind:'cts-c-paper-trade-ledger',profile,sourceHash:job.settings.sourceHash,symbol:job.symbol,indication:job.type,ordersSubmitted:0})+'\n')
  for(let hour=0;hour<job.settings.hours;hour++){
   const first=job.settings.warmup+hour*60,events=engine.processCandles(job.symbol,bars.slice(first,first+60)),hourTotals=Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,hourGroups=new Map<string,Totals>();let lines=''
   for(const event of events){
    if(!['opened','added','closed'].includes(event.type))continue
    const lane=JSON.parse(event.laneId),config=byId.get(lane[2]);if(!config)throw Error('An event escaped its exact configuration')
    const delta=empty()
    if(event.type==='opened')delta.entries++
    if(event.type==='added')delta.additions++
    if(event.trade){const t=event.trade;if(t.stage!=='base'&&(!t.admission?.length||t.admission.some(p=>!p.qualified)))throw Error('Unproven post-Base trade entered the forward ledger');delta.closes=1;delta.wins=Number(t.netReturnPct>0);delta.profit=Math.max(0,t.netReturnPct);delta.loss=Math.max(0,-t.netReturnPct);delta.netPnl=t.netPnl;delta.cost=t.cost;delta.notional=t.notional;lines+=JSON.stringify(t)+'\n'}
    add(totals[event.stage],delta);add(hourTotals[event.stage],delta)
    const tags:Record<Dimension,string>={symbol:job.symbol,type:job.type,range:config.range!,coordination:lane[4],direction:lane[3],exitMode:config.exitMode!,tpStep:String(config.tpStep),slRatio:String(config.slRatio),source:config.indicationSourceId??job.type}
    const strategyKey=JSON.stringify([event.stage,tags.range,tags.coordination,tags.exitMode]),strategyRow=strategies.get(strategyKey)??empty();add(strategyRow,delta);strategies.set(strategyKey,strategyRow)
    for(const dimension of dimensions){const key=JSON.stringify([event.stage,dimension,tags[dimension]]),row=groups.get(key)??empty();add(row,delta);groups.set(key,row)}
    for(const dimension of ['range','coordination','direction','exitMode'] as const){const key=JSON.stringify([event.stage,dimension,tags[dimension]]),row=hourGroups.get(key)??empty();add(row,delta);hourGroups.set(key,row)}
   }
   if(lines&&!stream.write(lines))await once(stream,'drain')
   const snap=engine.snapshot({laneLimit:hour===job.settings.hours-1?Infinity:0,positionLimit:0})
   const coverage=Object.fromEntries(snap.stages.map(s=>[s.stage,{sets:s.currentLanes,enough:s.currentEnoughSamples,qualified:s.currentQualified,admissionReady:s.admissionReady,validatedSamples:s.validatedWindow?.samples??0,validatedSets:s.validatedWindow?.sets??0,validatedProfit:s.validatedWindow?.profit??0,validatedLoss:s.validatedWindow?.loss??0,unfinished:s.open}])) as Record<Stage,Coverage>
   hourly.push({hour,stages:hourTotals,coverage,groups:[...hourGroups].map(([key,totals])=>({key,totals}))})
   if(hour===job.settings.hours-1)for(const lane of snap.lanes){const c=byId.get(lane.configId)!;const tags:Record<Dimension,string>={symbol:job.symbol,type:job.type,range:c.range!,coordination:lane.coordination,direction:lane.direction,exitMode:c.exitMode!,tpStep:String(c.tpStep),slRatio:String(c.slRatio),source:c.indicationSourceId??job.type};const strategyKey=JSON.stringify([lane.stage,tags.range,tags.coordination,tags.exitMode]),strategyRow=strategyCoverage.get(strategyKey)??{sets:0,enough:0};strategyRow.sets++;strategyRow.enough+=Number(lane.enoughSamples);strategyCoverage.set(strategyKey,strategyRow);for(const dimension of dimensions){const key=JSON.stringify([lane.stage,dimension,tags[dimension]]),r=coverageGroups.get(key)??{sets:0,enough:0};r.sets++;r.enough+=Number(lane.enoughSamples);coverageGroups.set(key,r)}}
  }
  stream.end();await done
  results.push({profile:profile.name,totals,strategyGroups:[...strategies].map(([key,totals])=>({key,totals})),strategyCoverage:[...strategyCoverage].map(([key,value])=>({key,...value})),groups:[...groups].map(([key,totals])=>({key,totals})),coverageGroups:[...coverageGroups].map(([key,value])=>({key,...value})),hourly})
 }
 return {id:job.id,symbol:job.symbol,type:job.type,sourceHash:job.settings.sourceHash,datasetSha256:job.dataset.sha256,configurations:configs.length,results,performance:{elapsedMs:performance.now()-started,maxRssKiB:process.resourceUsage().maxRSS}}
}

function mergeRows(target:Map<string,Totals>,rows:{key:string;totals:Totals}[],prefix?:unknown[]){for(const row of rows){const key=prefix?JSON.stringify([...prefix,...JSON.parse(row.key)]):row.key,value=target.get(key)??empty();add(value,row.totals);target.set(key,value)}}
async function main(){
 const root=resolve(arg('--data')),output=resolve(arg('--output')),count=Number(arg('--symbols','50')),warmup=Number(arg('--warmup','4320')),hours=Number(arg('--hours','24')),concurrency=Number(arg('--workers','2'))
 if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(warmup)||warmup<100||warmup>4320||!Number.isInteger(hours)||hours<1||hours>48||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Invalid bounded simulation dimensions')
 await mkdir(output,{recursive:true});await mkdir(join(output,'completed'),{recursive:true})
 const feeEvidence=JSON.parse(await readFile(resolve(arg('--fee-evidence')),'utf8'));if(feeEvidence.connection!=='bingx-x02'||feeEvidence.ordersSubmitted!==0||!feeEvidence.fees)throw Error('Verified x02 fee evidence is required')
 const settings:Settings={sourceHash:await sourceDigest(),warmup,hours,fees:feeEvidence.fees,catalog:{strategyTpSteps:[3,5,8,12,18,24,30],strategySlRatios:[.6,1,1.4],strategyExitModes:['fixed','trailing','trailing-only'],strategySignalPeriods:[20],strategySignalTimeframes:[1],slippagePctOfFees:10}}
 const manifest=await prepare(root,count,warmup,hours),metadata={kind:'cts-c-50-symbol-observed-stage-simulation',generatedAt:new Date().toISOString(),settings,profiles,manifest,feeEvidence,ordersSubmitted:0,actualExchangeExecutionPF:null,automaticPromotion:false}
 await atomic(join(output,'run.json'),metadata)
 if(process.argv.includes('--prepare-only')){console.log(JSON.stringify({phase:'history-ready',symbols:manifest.symbols.length,manifest:join(root,'manifest.json')}));return}
 const jobs=manifest.datasets.flatMap(dataset=>INDICATIONS.map(type=>({id:safeName(dataset.symbol+'__'+type),symbol:dataset.symbol,type,root,output,settings,dataset}))),results=new Set<string>(),pending:Job[]=[]
 for(const job of jobs){try{const done=JSON.parse(await readFile(join(output,'completed',job.id+'.json'),'utf8'));if(done.sourceHash!==settings.sourceHash||done.datasetSha256!==job.dataset.sha256)throw Error('Existing replay checkpoint belongs to different source or data');results.add(job.id)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')pending.push(job);else throw e}}
 let cursor=0,active=0;const started=performance.now(),children=new Set<ChildProcess>()
 const progress=()=>console.log(JSON.stringify({phase:'strategy-replay',completed:results.size,total:jobs.length,active,elapsedSeconds:Math.round((performance.now()-started)/1000)}))
 const timer=setInterval(progress,15000)
 try{await Promise.all(Array.from({length:Math.min(concurrency,pending.length)},()=>new Promise<void>((resolveWorker,reject)=>{
  const child=fork(resolve(process.argv[1]),['--worker'],{execArgv:['--import','tsx','--max-old-space-size=640','--expose-gc'],stdio:['ignore','inherit','inherit','ipc'],env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:'production',TZ:'UTC'}});children.add(child);let busy=false,finished=false
  const next=()=>{const job=pending[cursor++];if(!job){finished=true;child.disconnect();child.kill('SIGTERM');children.delete(child);resolveWorker();return}busy=true;active++;child.send(job)}
  child.on('message',(message:any)=>{void(async()=>{if(message.error)throw Error(message.error);const result=message.result;if(!busy||!result?.id)throw Error('Invalid simulation worker result');await atomic(join(output,'completed',result.id+'.json'),result);results.add(result.id);busy=false;active--;next()})().catch(reject)})
  child.on('error',reject);child.on('exit',(code,signal)=>{if(!finished)reject(Error('Simulation worker stopped: '+code+'/'+signal))});next()
 })))}finally{clearInterval(timer);for(const child of children)child.kill('SIGTERM')}
 if(results.size!==jobs.length)throw Error('Simulation did not complete every symbol/indication job')
 const summaries=[]
 for(const profile of profiles){
  const totals=Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,groups=new Map<string,Totals>(),strategyGroups=new Map<string,Totals>(),strategyCoverage=new Map<string,{sets:number;enough:number}>(),typeHourCoverage=new Map<string,Coverage>(),typeGroups=new Map<string,Totals>(),hourGroups=new Map<string,Totals>(),typeHourGroups=new Map<string,Totals>(),typeCoverGroups=new Map<string,{sets:number;enough:number}>(),coverGroups=new Map<string,{sets:number;enough:number}>(),hourly=Array.from({length:hours},(_,hour)=>({hour,stages:Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,coverage:Object.fromEntries(STAGES.map(s=>[s,coverageEmpty()])) as Record<Stage,Coverage>}))
  let configs=0,maxWorkerRssKiB=0,engineMs=0
  for(const id of results){
   const result=JSON.parse(await readFile(join(output,'completed',id+'.json'),'utf8'))
   const r=result.results.find((r:any)=>r.profile===profile.name);configs+=result.configurations;maxWorkerRssKiB=Math.max(maxWorkerRssKiB,result.performance.maxRssKiB);engineMs+=result.performance.elapsedMs
   for(const stage of STAGES)add(totals[stage],r.totals[stage]);mergeRows(groups,r.groups);mergeRows(typeGroups,r.groups,[result.type]);mergeRows(strategyGroups,r.strategyGroups,[result.type]);for(const c of r.strategyCoverage){const key=JSON.stringify([result.type,...JSON.parse(c.key)]),v=strategyCoverage.get(key)??{sets:0,enough:0};v.sets+=c.sets;v.enough+=c.enough;strategyCoverage.set(key,v)}
   for(const c of r.coverageGroups){const row=coverGroups.get(c.key)??{sets:0,enough:0};row.sets+=c.sets;row.enough+=c.enough;coverGroups.set(c.key,row);const typeKey=JSON.stringify([result.type,...JSON.parse(c.key)]),typeRow=typeCoverGroups.get(typeKey)??{sets:0,enough:0};typeRow.sets+=c.sets;typeRow.enough+=c.enough;typeCoverGroups.set(typeKey,typeRow)}
   for(const h of r.hourly){for(const stage of STAGES){add(hourly[h.hour].stages[stage],h.stages[stage]);addCoverage(hourly[h.hour].coverage[stage],h.coverage[stage]);const typeKey=JSON.stringify([h.hour,result.type,stage]),typeRow=typeHourCoverage.get(typeKey)??coverageEmpty();addCoverage(typeRow,h.coverage[stage]);typeHourCoverage.set(typeKey,typeRow)}mergeRows(hourGroups,h.groups,[h.hour]);mergeRows(typeHourGroups,h.groups,[h.hour,result.type]);mergeRows(hourGroups,STAGES.map(stage=>({key:JSON.stringify([stage,'type',result.type]),totals:h.stages[stage]})),[h.hour])}
  }
  summaries.push({profile,configurationsAcrossSymbols:configs,stages:Object.fromEntries(STAGES.map(stage=>[stage,measured(totals[stage])])),hourly:hourly.map(h=>({...h,stages:Object.fromEntries(STAGES.map(stage=>[stage,measured(h.stages[stage])]))})),groups:[...groups].map(([key,value])=>({key,...measured(value)})),indicationStrategies:[...strategyGroups].map(([key,value])=>({key,...measured(value)})),indicationStrategyCoverage:[...strategyCoverage].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),typeHourlyCoverage:[...typeHourCoverage].map(([key,value])=>({key,...value})),typeGroups:[...typeGroups].map(([key,value])=>({key,...measured(value)})),typeCoverageGroups:[...typeCoverGroups].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),typeHourlyGroups:[...typeHourGroups].map(([key,value])=>({key,...measured(value)})),hourlyGroups:[...hourGroups].map(([key,value])=>({key,...measured(value)})),coverageGroups:[...coverGroups].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),performance:{maxWorkerRssKiB,summedJobWallMs:engineMs}})
 }
 const complete={...metadata,completedAt:new Date().toISOString(),completedJobs:results.size,types:[...INDICATIONS],summaries,methodology:'Observed BingX VST closed one-minute candles only, 72h prehistory and 24h forward unless explicitly overridden. All 19 indication families calculate independently, with balanced TP steps 3/5/8/12/18/24/30, SL/TP 0.6/1/1.4, three exits, long/short and Normal/Axis/Block/DCA. Tactic and Inverse use the ten declared default imported sources; all 1190 selectable source identities are separately covered by functional golden-state tests. Higher timeframes and the full Cartesian catalog are separately tested, not all enabled in this bounded run. Each policy warms its own stages from prehistory; unfinished warmup positions are discarded. Every subsequent loss remains in the forward ledger. Symbol admission uses available contracts and complete history only, never returns. No shortlist is chosen from this forward period. Enough-samples percentages divide current created sets with their own required completed samples by current created sets; zero sets means unavailable, not 0% passing. Validated-window PF is current selection evidence and is separate from all admitted forward closes. Model fills occur at observed closes and deduct verified taker fees plus fee-relative slippage once; exchange minimum sizing, latency, funding and native protective fills are not simulated. Correlated lane cash totals and 10,000-unit closed-only paper equity do not represent an executable exchange portfolio. Actual exchange PF is unavailable in this no-write simulation. Defaults are not promoted automatically.'}
 await atomic(join(output,'summary.json'),complete);progress();console.log(JSON.stringify({phase:'complete',output:join(output,'summary.json'),profiles:summaries.map(s=>({name:s.profile.name,stages:s.stages}))}))
}
if(process.argv.includes('--worker'))process.on('message',(job:Job)=>{void runJob(job).then(result=>{process.send?.({result});(globalThis as any).gc?.()}).catch(e=>process.send?.({error:e instanceof Error?e.message:'Worker failed'}))})
else void main().catch(e=>{console.error(e instanceof Error?e.message:'Simulation failed');process.exitCode=1})
