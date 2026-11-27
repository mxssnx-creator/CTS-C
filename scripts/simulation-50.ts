/** Bounded, resumable observed-market replay. Workers never construct a private exchange client. */
import {fork,type ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {once} from 'node:events'
import {pipeline} from 'node:stream/promises'
import {createGzip} from 'node:zlib'
import {setPriority} from 'node:os'
import {Session} from 'node:inspector'
import {selectTrainingConfigurations} from '../core/training-selection'
import {BingxVstClient,BINGX_VST_HOST} from '../core/bingx'
import {TradingEngine,validateObservedCandles,STAGES} from '../core/engine'
import {generateStrategyCatalog} from '../core/catalog'
import {INDICATIONS} from '../core/indications'
import {describeProfitFactor} from '../core/metrics'
import {checkExecWindows} from '../core/last-n-grid'
import {DEFAULT_TACTIC_SOURCES,DEFAULT_INVERSE_SOURCES} from '../shared/cts-indications/catalog'
import {REVERSAL_SOURCES} from '../shared/cts-reversal/reversal'
import type {Candle,EngineEvent,StrategyConfig,Stage} from '../core/types'

const arg=(name:string,fallback?:string)=>{const at=process.argv.indexOf(name);if(at>=0&&process.argv[at+1])return process.argv[at+1];if(fallback!==undefined)return fallback;throw Error('Provide '+name)}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const empty=()=>({closes:0,wins:0,profit:0,loss:0,netPnl:0,cost:0,notional:0,entries:0,additions:0})
type Totals=ReturnType<typeof empty>
const totalKeys=Object.keys(empty()) as (keyof Totals)[]
const add=(a:Totals,b:Totals)=>{for(const k of totalKeys)a[k]+=b[k]}
const getTotals=(m:Map<string,Totals>,key:string)=>{let row=m.get(key);if(!row){row=empty();m.set(key,row)}return row}
const closeKeys=['closes','wins','profit','loss','netPnl','cost','notional'] as const
function applyEvent(t:Totals,d:Totals,kind:string){if(kind==='opened')t.entries++;else if(kind==='added')t.additions++;else for(const k of closeKeys)t[k]+=d[k]}
const measured=(a:Totals)=>({...a,...describeProfitFactor(a.profit,a.loss,a.closes),modeledOrderActions:a.entries+a.additions+a.closes})
const coverageEmpty=()=>({sets:0,enough:0,qualified:0,admissionReady:0,validatedSamples:0,validatedSets:0,validatedProfit:0,validatedLoss:0,ownQualifiedSets:0,ownQualifiedSamples:0,ownQualifiedProfit:0,ownQualifiedLoss:0,unfinished:0})
type Coverage=ReturnType<typeof coverageEmpty>
const addCoverage=(a:Coverage,b:Coverage)=>{for(const k of Object.keys(a) as (keyof Coverage)[])a[k]+=b[k]}
// Exec and Base branch lanes derive from their catalog geometry by appending .branch/.coordination/.stage suffixes; catalog ids contain no dots.
const baseConfigId=(id:string)=>id.split('.')[0]!
const safeName=(s:string)=>s.replace(/[^a-zA-Z0-9_.-]/g,'_')
// Three independent engines per symbol and indication. Processed-set gating covers Base→Main→Real→Live; exec-branches adds Exec.
const baseProfiles=[
 {name:'processed-pyramid-20-8-8',gate:'processed-sets' as const,blockBehavior:'pyramid' as const,execWindows:false},
 {name:'processed-rounds-20-8-8',gate:'processed-sets' as const,blockBehavior:'rounds' as const,execWindows:false},
 {name:'exec-branches-pyramid-20-8-8',gate:'exec-branches' as const,blockBehavior:'pyramid' as const,execWindows:true},
]
const profiles=[...baseProfiles,...baseProfiles.map(p=>({...p,name:'prehistory-selected-'+p.name,frozenPrehistory:true}))]
// Small exec-window grid from the Exec replays; the default grid exceeds one worker's heap.
const EXEC_WINDOWS=checkExecWindows({base:{long:[10],short:[4],last:[1]},main:{long:['none'],short:[4],last:[1]},real:{long:['none'],short:[4],last:[1]},exec:{long:['none'],short:[4],last:[1]}})
const dimensions=['symbol','type','range','coordination','direction','exitMode','tpStep','slRatio','source'] as const
type Dimension=typeof dimensions[number]
type Settings={sourceHash:string;warmup:number;hours:number;bucketMinutes:number;fees:{makerFeePct:number;takerFeePct:number};catalog:Record<string,unknown>}
type Manifest={cutoff:number;start:number;symbols:string[];datasets:{symbol:string;file:string;sha256:string;bars:number}[];excluded:{symbol:string;reason:string}[]}
type Job={id:string;symbol:string;type:string;root:string;output:string;settings:Settings;dataset:Manifest['datasets'][number]}
async function atomic(path:string,value:unknown){const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2));await rename(tmp,path)}

async function sourceDigest(){const manifest=JSON.parse(await readFile('shared/cts-indications/source-manifest.json','utf8'));const files=['core/engine.ts','core/block-rounds.ts','core/indications.ts','core/catalog.ts','core/replay.ts','core/metrics.ts','core/exits.ts','core/technical-signals.ts','core/strategy-processing.ts','shared/cts-indications/signals-catalog.ts','shared/cts-indications/signals-sources.json','core/training-selection.ts','shared/cts-volume/ratios.ts','shared/cts-indications/index.ts','shared/cts-indications/catalog.ts','shared/cts-indications/source-manifest.json','scripts/simulation-50.ts',...Object.keys(manifest.sha256).map(p=>'shared/cts-indications/origin/'+p)];return hash((await Promise.all(files.map(async p=>p+'\n'+await readFile(resolve(p),'utf8')))).join('\n'))}
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
 const started=performance.now(),usage=process.resourceUsage(),raw=await readFile(join(job.root,job.dataset.file),'utf8');if(hash(raw)!==job.dataset.sha256)throw Error('Observed dataset digest mismatch')
 const bars=JSON.parse(raw) as Candle[];validateObservedCandles(bars)
 const catalog={...job.settings.catalog,...job.settings.fees,strategyIndicationTypes:[job.type]},configs=generateStrategyCatalog('bingx-x02',catalog),byId=new Map(configs.map(c=>[c.id,c])),results=[],trainingSelections=[],calculationProof=[]
 const bucketCount=job.settings.hours*60/job.settings.bucketMinutes,bucketLength=job.settings.bucketMinutes
 const make=(name:string,frozenPrehistory:boolean,configurations:number)=>({profile:name,frozenPrehistory,configurations,totals:Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,groups:new Map<string,Totals>(),strategies:new Map<string,Totals>(),strategyCoverage:new Map<string,{sets:number;enough:number}>(),buckets:[] as any[],coverageGroups:new Map<string,{sets:number;enough:number}>()})
 for(const profile of baseProfiles){
  const profileCatalog=profile.execWindows?{...catalog,strategyExecWindows:EXEC_WINDOWS}:catalog
  let engine=new TradingEngine({symbols:[job.symbol],catalog:profileCatalog,stageGateMode:profile.gate,liveEntryMode:'real-mirror',stageLastN:{base:20,main:8,real:8},stageMinPF:{base:1.1,main:1.1,real:1.1},coordinations:{axis:{enabled:true,previous:8,last:3,outcome:'any',reference:'same-stage'},block:{enabled:true,steps:3,ratio:.2,mode:'shared',behavior:profile.blockBehavior,size:3,pauseRounds:1,maxMultiplier:3},dca:{enabled:true,steps:2,distancePct:1,multiplier:2},relate:{enabled:true,steps:5,ratio:.2,stepMode:'loss',lastN:250,minTrades:60,minPF:1.1,maxMultiplier:2,maxSlRatio:.5}}})
  engine.processCandles(job.symbol,bars.slice(0,job.settings.warmup),{eventLimit:0})
  const trained=engine.exportState(),selection=selectTrainingConfigurations(Object.values(trained.lanes),configs,job.symbol);trainingSelections.push({profile:profile.name,...selection});const selected=new Set(selection.selectedIds)
  for(const lane of Object.values(trained.lanes))delete lane.open
  engine=TradingEngine.fromOwnedCheckpoint(trained)
  const accumulators=[make(profile.name,false,configs.length),make('prehistory-selected-'+profile.name,true,selected.size)]
  const bindings=new Map<string,{config:StrategyConfig;stage:Stage;targets:Totals[];participants:number[];bucketKeys:string[];bucket:number;bucketTargets:Totals[]}>()
  const folder=join(job.output,'trades',safeName(job.symbol),safeName(job.type));await mkdir(folder,{recursive:true})
  const stream=createGzip({level:1}),done=pipeline(stream,createWriteStream(join(folder,profile.name+'.ndjson.gz')));void done.catch(()=>{})
  stream.write(JSON.stringify({kind:'cts-c-paper-trade-ledger',profile:profile.name,gate:profile.gate,sourceHash:job.settings.sourceHash,symbol:job.symbol,indication:job.type,prehistorySelectedIds:selection.selectedIds,ordersSubmitted:0})+'\n')
  for(let bucket=0;bucket<bucketCount;bucket++){
   const first=job.settings.warmup+bucket*bucketLength,bucketRows=accumulators.map(()=>({stages:Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,groups:new Map<string,Totals>()}));let lines=''
   for(let offset=first;offset<first+bucketLength;offset+=5){
    const events=engine.processCandles(job.symbol,bars.slice(offset,offset+5))
    for(const event of events){
     if(!['opened','added','closed'].includes(event.type))continue
     let binding=bindings.get(event.laneId)
     if(!binding){
      const lane=JSON.parse(event.laneId),config=byId.get(baseConfigId(lane[2]));if(!config||lane[5]!==event.stage)throw Error('An event escaped its exact configuration')
      const tags:Record<Dimension,string>={symbol:job.symbol,type:job.type,range:config.range!,coordination:lane[4],direction:lane[3],exitMode:config.exitMode!,tpStep:String(config.tpStep),slRatio:String(config.slRatio),source:config.indicationSourceId??job.type},keys=dimensions.map(dim=>JSON.stringify([event.stage,dim,tags[dim]])),bucketKeys=(['range','coordination','direction','exitMode','tpStep','slRatio','source']as const).map(dim=>JSON.stringify([event.stage,dim,tags[dim]])),targets:Totals[]=[],participants:number[]=[]
      for(const [index,a]of accumulators.entries()){if(a.frozenPrehistory&&!selected.has(config.id))continue;participants.push(index);targets.push(a.totals[event.stage],getTotals(a.strategies,JSON.stringify([event.stage,tags.range,tags.coordination,tags.exitMode])),...keys.map(key=>getTotals(a.groups,key)))}
      binding={config,stage:event.stage,targets,participants,bucketKeys,bucket:-1,bucketTargets:[]};bindings.set(event.laneId,binding)
     }
     if(binding.bucket!==bucket){binding.bucket=bucket;binding.bucketTargets=binding.participants.flatMap(i=>[bucketRows[i].stages[binding!.stage],...binding!.bucketKeys.map(key=>getTotals(bucketRows[i].groups,key))])}

     const delta=empty()
     if(event.type==='opened')delta.entries++
     if(event.type==='added')delta.additions++
     if(event.trade){const t=event.trade;if(t.stage!=='base'&&(!t.admission?.length||t.admission.some(p=>!p.qualified)))throw Error('Unproven post-Base trade entered the forward ledger');delta.closes=1;delta.wins=Number(t.netReturnPct>0);delta.profit=Math.max(0,t.netReturnPct);delta.loss=Math.max(0,-t.netReturnPct);delta.netPnl=t.netPnl;delta.cost=t.cost;delta.notional=t.notional;lines+=JSON.stringify(t)+'\n'}
     for(const target of binding.targets)applyEvent(target,delta,event.type)
     for(const target of binding.bucketTargets)applyEvent(target,delta,event.type)
    }
    if(lines&&!stream.write(lines))await once(stream,'drain');lines=''
   }
   // Coverage is sampled once per reporting bucket, which bounds the cost of full lane snapshots.
   const snap=engine.snapshot({laneLimit:Infinity,positionLimit:0})
   for(const [index,a]of accumulators.entries()){
    const coverage=Object.fromEntries(STAGES.map(s=>[s,coverageEmpty()])) as Record<Stage,Coverage>
    for(const lane of snap.lanes){
     if(!lane.current||a.frozenPrehistory&&!selected.has(lane.configId))continue
     const r=coverage[lane.stage];r.sets++;r.enough+=Number(lane.enoughSamples);r.qualified+=Number(lane.validated);r.admissionReady+=Number(lane.admissionReady);r.unfinished+=Number(lane.isOpen)
     if(lane.qualified){r.ownQualifiedSets++;r.ownQualifiedSamples+=lane.count;r.ownQualifiedProfit+=lane.profit??0;r.ownQualifiedLoss+=lane.loss??0}
     if(lane.validated){r.validatedSets++;r.validatedSamples+=lane.count;r.validatedProfit+=lane.profit??0;r.validatedLoss+=lane.loss??0}
     if(bucket===bucketCount-1){
      const c=byId.get(baseConfigId(lane.configId))!,tags:Record<Dimension,string>={symbol:job.symbol,type:job.type,range:c.range!,coordination:lane.coordination,direction:lane.direction,exitMode:c.exitMode!,tpStep:String(c.tpStep),slRatio:String(c.slRatio),source:c.indicationSourceId??job.type}
      const sk=JSON.stringify([lane.stage,tags.range,tags.coordination,tags.exitMode]),sr=a.strategyCoverage.get(sk)??{sets:0,enough:0};sr.sets++;sr.enough+=Number(lane.enoughSamples);a.strategyCoverage.set(sk,sr)
      for(const dim of dimensions){const key=JSON.stringify([lane.stage,dim,tags[dim]]),row=a.coverageGroups.get(key)??{sets:0,enough:0};row.sets++;row.enough+=Number(lane.enoughSamples);a.coverageGroups.set(key,row)}
     }
    }
    a.buckets.push({bucket,stages:bucketRows[index].stages,coverage,groups:[...bucketRows[index].groups].map(([key,totals])=>({key,totals}))})
   }
  }
  const finalCheck=engine.snapshot({laneLimit:0,positionLimit:0});if(finalCheck.processedCandles!==bars.length||engine.lastProcessedAt(job.symbol)!==bars.at(-1)!.timestamp)throw Error('Indication did not consume the complete observed series')
  calculationProof.push({profile:profile.name,gate:profile.gate,processedCandles:finalCheck.processedCandles,lastTimestamp:engine.lastProcessedAt(job.symbol)})
  stream.end();await done
  for(const a of accumulators)results.push({profile:a.profile,frozenPrehistory:a.frozenPrehistory,configurations:a.configurations,totals:a.totals,strategyGroups:[...a.strategies].map(([key,totals])=>({key,totals})),strategyCoverage:[...a.strategyCoverage].map(([key,value])=>({key,...value})),groups:[...a.groups].map(([key,totals])=>({key,totals})),coverageGroups:[...a.coverageGroups].map(([key,value])=>({key,...value})),buckets:a.buckets})
 }
 const after=process.resourceUsage()
 return {id:job.id,symbol:job.symbol,type:job.type,sourceHash:job.settings.sourceHash,datasetSha256:job.dataset.sha256,configurations:configs.length,calculationProof,trainingSelections,results,performance:{elapsedMs:performance.now()-started,userCpuMs:(after.userCPUTime-usage.userCPUTime)/1000,systemCpuMs:(after.systemCPUTime-usage.systemCPUTime)/1000,maxRssKiB:after.maxRSS}}
}

function mergeRows(target:Map<string,Totals>,rows:{key:string;totals:Totals}[],prefix?:unknown[]){for(const row of rows){const key=prefix?JSON.stringify([...prefix,...JSON.parse(row.key)]):row.key,value=target.get(key)??empty();add(value,row.totals);target.set(key,value)}}
async function main(){
 const root=resolve(arg('--data')),output=resolve(arg('--output')),count=Number(arg('--symbols','50')),warmup=Number(arg('--warmup','4320')),hours=Number(arg('--hours','24')),bucketHours=Number(arg('--bucket-hours','4')),concurrency=Number(arg('--workers','2'))
 const shards=Number(arg('--shards','1')),shardIndex=Number(arg('--shard-index','0'))
 if(!Number.isInteger(shards)||shards<1||shards>50||!Number.isInteger(shardIndex)||shardIndex<0||shardIndex>=shards||process.argv.includes('--assemble-only')&&shards!==1)throw Error('Invalid simulation shard')
 if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(warmup)||warmup<100||warmup>4320||!Number.isInteger(hours)||hours<1||hours>120||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Invalid bounded simulation dimensions')
 if(!Number.isInteger(bucketHours)||bucketHours<1||hours%bucketHours!==0)throw Error('Bucket hours must divide the scored window')
 const typeFilter=arg('--types','').split(',').filter(Boolean),selectedTypes=typeFilter.length?INDICATIONS.filter(t=>typeFilter.includes(t)):[...INDICATIONS];if(typeFilter.length&&selectedTypes.length!==typeFilter.length)throw Error('Unknown indication type in --types')
 await mkdir(output,{recursive:true});await mkdir(join(output,'completed'),{recursive:true})
 // Either a verified x02 commission read, or an explicit documented-default fee set (flagged unverified in run.json).
 const feeEvidence=process.argv.includes('--documented-default-fees')?{connection:'bingx-x02',ordersSubmitted:0,verified:false,feeSource:'documented-defaults-unverified',fees:{makerFeePct:0.02,takerFeePct:0.05,slippagePctOfFees:10}}:JSON.parse(await readFile(resolve(arg('--fee-evidence')),'utf8'));if(feeEvidence.connection!=='bingx-x02'||feeEvidence.ordersSubmitted!==0||!feeEvidence.fees)throw Error('Verified x02 fee evidence is required')
 // Every enabled source: declared default Tactic and Inverse sources plus all Trend-Reversal sources. Signals and Low-Range use their defaults.
 const indicationSources=[...DEFAULT_TACTIC_SOURCES,...DEFAULT_INVERSE_SOURCES,...REVERSAL_SOURCES.map(source=>source.id)]
 const settings:Settings={sourceHash:await sourceDigest(),warmup,hours,bucketMinutes:bucketHours*60,fees:feeEvidence.fees,catalog:{strategyEnabledRanges:['Micro','Minimal','Short','Normal','Long','Wide','Low-Range'],strategyTpSteps:[2,3,5,8,12,18,24,30],strategySlRatios:[.6,1,1.4],microTrailRatio:.5,autoPfEnabled:true,autoPfRatio:.2,autoPfMax:2,strategyExitModes:['fixed','trailing','trailing-only'],strategySignalPeriods:[20],strategySignalTimeframes:[1],slippagePctOfFees:10,strategyIndicationSources:indicationSources}}
 const manifest=await prepare(root,count,warmup,hours),metadata={kind:'cts-c-observed-stage-simulation',generatedAt:new Date().toISOString(),settings,profiles,types:selectedTypes,manifest,feeEvidence,workerLimits:{concurrency,heapMiB:1536,nice:10,maxEventBatchCandles:5},ordersSubmitted:0,actualExchangeExecutionPF:null,automaticPromotion:false}
 await atomic(join(output,'run.json'),metadata)
 if(process.argv.includes('--prepare-only')){console.log(JSON.stringify({phase:'history-ready',symbols:manifest.symbols.length,manifest:join(root,'manifest.json')}));return}
 const jobs=manifest.datasets.flatMap(dataset=>selectedTypes.map(type=>({id:safeName(dataset.symbol+'__'+type),symbol:dataset.symbol,type,root,output,settings,dataset}))).filter((_,i)=>i%shards===shardIndex),results=new Set<string>(),pending:Job[]=[]
 for(const job of jobs){try{const done=JSON.parse(await readFile(join(output,'completed',job.id+'.json'),'utf8'));if(done.sourceHash!==settings.sourceHash||done.datasetSha256!==job.dataset.sha256)throw Error('Existing replay checkpoint belongs to different source or data');results.add(job.id)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')pending.push(job);else throw e}}
 if(process.argv.includes('--assemble-only')&&pending.length)throw Error('Cannot assemble incomplete replay: '+pending.length+' missing jobs')
 let cursor=0,active=0;const started=performance.now(),children=new Set<ChildProcess>()
 const progress=()=>console.log(JSON.stringify({phase:'indication-replay',completed:results.size,total:jobs.length,active,elapsedSeconds:Math.round((performance.now()-started)/1000)}))
 const timer=setInterval(progress,15000)
 try{await Promise.all(Array.from({length:Math.min(concurrency,pending.length)},()=>new Promise<void>((resolveWorker,reject)=>{
  const child=fork(resolve(process.argv[1]),['--worker'],{execArgv:['--import','tsx','--max-old-space-size=1536','--expose-gc'],stdio:['ignore','inherit','inherit','ipc'],env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:'production',TZ:'UTC',...(process.env.CTS_SIM_CPU_PROFILE?{CTS_SIM_CPU_PROFILE:process.env.CTS_SIM_CPU_PROFILE}:{})}});children.add(child);let busy=false,finished=false
  const next=()=>{const job=pending[cursor++];if(!job){finished=true;child.disconnect();child.kill('SIGTERM');children.delete(child);resolveWorker();return}busy=true;active++;child.send(job)}
  child.on('message',(message:any)=>{void(async()=>{if(message.error)throw Error(message.error);const result=message.result;if(!busy||!result?.id)throw Error('Invalid simulation worker result');await atomic(join(output,'completed',result.id+'.json'),result);results.add(result.id);busy=false;active--;next()})().catch(reject)})
  child.on('error',reject);child.on('exit',(code,signal)=>{if(!finished)reject(Error('Simulation worker stopped: '+code+'/'+signal))});next()
 })))}finally{clearInterval(timer);for(const child of children)child.kill('SIGTERM')}
 if(results.size!==jobs.length)throw Error('Simulation did not complete every symbol/indication job')
 if(shards>1){await atomic(join(output,'shard-'+shardIndex+'.json'),{sourceHash:settings.sourceHash,shardIndex,shards,completedJobs:results.size,jobs:[...results],complete:true});console.log(JSON.stringify({phase:'shard-complete',shardIndex,shards,jobs:results.size}));return}
 const bucketCount=hours/bucketHours,bucketStart=(index:number)=>new Date(manifest.start+(warmup+index*bucketHours*60)*60000).toISOString()
 const summaries=[]
 for(const profile of profiles){
  const totals=Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,groups=new Map<string,Totals>(),strategyGroups=new Map<string,Totals>(),strategyCoverage=new Map<string,{sets:number;enough:number}>(),typeBucketCoverage=new Map<string,Coverage>(),typeGroups=new Map<string,Totals>(),bucketGroupsAll=new Map<string,Totals>(),typeBucketGroups=new Map<string,Totals>(),typeCoverGroups=new Map<string,{sets:number;enough:number}>(),coverGroups=new Map<string,{sets:number;enough:number}>()
  const buckets=Array.from({length:bucketCount},(_,bucket)=>({bucket,startUtc:bucketStart(bucket),endUtc:bucketStart(bucket+1),stages:Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,Totals>,coverage:Object.fromEntries(STAGES.map(s=>[s,coverageEmpty()])) as Record<Stage,Coverage>}))
  let configs=0,maxWorkerRssKiB=0,engineMs=0
  for(const id of results){
   const result=JSON.parse(await readFile(join(output,'completed',id+'.json'),'utf8'))
   const r=result.results.find((r:any)=>r.profile===profile.name);configs+=r.configurations;maxWorkerRssKiB=Math.max(maxWorkerRssKiB,result.performance.maxRssKiB);engineMs+=result.performance.elapsedMs
   for(const stage of STAGES)add(totals[stage],r.totals[stage]);mergeRows(groups,r.groups);mergeRows(typeGroups,r.groups,[result.type]);mergeRows(strategyGroups,r.strategyGroups,[result.type]);for(const c of r.strategyCoverage){const key=JSON.stringify([result.type,...JSON.parse(c.key)]),v=strategyCoverage.get(key)??{sets:0,enough:0};v.sets+=c.sets;v.enough+=c.enough;strategyCoverage.set(key,v)}
   for(const c of r.coverageGroups){const row=coverGroups.get(c.key)??{sets:0,enough:0};row.sets+=c.sets;row.enough+=c.enough;coverGroups.set(c.key,row);const typeKey=JSON.stringify([result.type,...JSON.parse(c.key)]),typeRow=typeCoverGroups.get(typeKey)??{sets:0,enough:0};typeRow.sets+=c.sets;typeRow.enough+=c.enough;typeCoverGroups.set(typeKey,typeRow)}
   for(const b of r.buckets){const target=buckets[b.bucket];for(const stage of STAGES){add(target.stages[stage],b.stages[stage]);addCoverage(target.coverage[stage],b.coverage[stage]);const typeKey=JSON.stringify([b.bucket,result.type,stage]),typeRow=typeBucketCoverage.get(typeKey)??coverageEmpty();addCoverage(typeRow,b.coverage[stage]);typeBucketCoverage.set(typeKey,typeRow)}mergeRows(bucketGroupsAll,b.groups,[b.bucket]);mergeRows(typeBucketGroups,b.groups,[b.bucket,result.type]);mergeRows(bucketGroupsAll,STAGES.map(stage=>({key:JSON.stringify([stage,'type',result.type]),totals:b.stages[stage]})),[b.bucket])}
  }
  summaries.push({profile,configurationsAcrossSymbols:configs,stages:Object.fromEntries(STAGES.map(stage=>[stage,measured(totals[stage])])),buckets:buckets.map(b=>({bucket:b.bucket,startUtc:b.startUtc,endUtc:b.endUtc,stages:Object.fromEntries(STAGES.map(stage=>[stage,measured(b.stages[stage])])),coverage:Object.fromEntries(STAGES.map(stage=>[stage,{...b.coverage[stage],enoughSamplesPct:b.coverage[stage].sets?100*b.coverage[stage].enough/b.coverage[stage].sets:null}]))})),groups:[...groups].map(([key,value])=>({key,...measured(value)})),indicationStrategies:[...strategyGroups].map(([key,value])=>({key,...measured(value)})),indicationStrategyCoverage:[...strategyCoverage].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),typeBucketCoverage:[...typeBucketCoverage].map(([key,value])=>({key,...value})),typeGroups:[...typeGroups].map(([key,value])=>({key,...measured(value)})),typeCoverageGroups:[...typeCoverGroups].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),typeBucketGroups:[...typeBucketGroups].map(([key,value])=>({key,...measured(value)})),bucketGroups:[...bucketGroupsAll].map(([key,value])=>({key,...measured(value)})),coverageGroups:[...coverGroups].map(([key,value])=>({key,...value,enoughSamplesPct:value.sets?100*value.enough/value.sets:null})),performance:{maxWorkerRssKiB,summedJobWallMs:engineMs}})
 }
 const complete={...metadata,completedAt:new Date().toISOString(),completedJobs:results.size,summaries,methodology:'Observed BingX VST closed one-minute candles only. Prehistory is warmup (not scored) and the scored window follows it; both are taken from the manifest. Every selected indication family calculates independently with all seven ranges, the balanced TP steps 2/3/5/8/12/18/24/30, SL ratios 0.6/1/1.4, three exits, long/short, and Normal/Axis/Block/DCA/Relate coordinations. Three independent engines run per symbol and indication: processed-set pyramid Block, processed-set rounds Block, and exec-branches gating with the small Exec window grid (Exec is reported only in this third engine). Tactic and Inverse use the declared default imported sources; Trend-Reversal uses all of its sources. Each engine warms up from prehistory and only then scores the window. Signals additionally require the configured three-percentage-point net-return drawdown limit in each gate window. Symbol admission uses available contracts and complete history only, never returns. The prehistory-selected summaries are a frozen subset selected from Base prehistory outcomes only (at least 20 closes and PF 1.1). Forward losses remain included. Enough-samples percentages divide created sets by their own required samples; zero sets means unavailable, not 0%. Model fills occur at observed closes and deduct verified-default taker fees plus fee-relative slippage once. Exchange minimum sizing, latency, funding and native protective fills are not simulated. Actual exchange PF is unavailable in this no-write simulation. Defaults are not promoted automatically.'}
 await atomic(join(output,'summary.json'),complete);progress();console.log(JSON.stringify({phase:'complete',output:join(output,'summary.json'),profiles:summaries.map(s=>({name:s.profile.name,stages:s.stages}))}))
}
if(process.argv.includes('--worker')){try{setPriority(0,10)}catch{};process.on('message',(job:Job)=>{void(async()=>{
  // Optional diagnostic: CTS_SIM_CPU_PROFILE=<dir> writes one V8 CPU profile per job without changing results.
  const profileDir=process.env.CTS_SIM_CPU_PROFILE?resolve(process.env.CTS_SIM_CPU_PROFILE):undefined,session=profileDir?new Session():undefined
  if(session){await mkdir(profileDir!,{recursive:true});session.connect();await new Promise(r=>session.post('Profiler.enable',()=>session.post('Profiler.start',()=>r(undefined))))}
  let result:unknown,error:string|undefined
  try{result=await runJob(job)}catch(e){error=e instanceof Error?e.message:'Worker failed'}
  if(session){const profile:any=await new Promise(r=>session.post('Profiler.stop',(_e,v)=>r(v)));await writeFile(join(profileDir!,job.id+'.cpuprofile'),JSON.stringify(profile.profile));session.disconnect()}
  if(error!==undefined)process.send?.({error});else{process.send?.({result});(globalThis as any).gc?.()}
 })()})}
else void main().catch(e=>{console.error(e instanceof Error?e.message:'Simulation failed');process.exitCode=1})
