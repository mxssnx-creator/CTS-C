/** Repeatable frozen-selection stage A/B. No exchange client or venue writes. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {TradingEngine} from '../core/engine'
import {describeProfitFactor} from '../core/metrics'
import type {Candle,EngineEvent,Stage,EngineSettings} from '../core/types'
const option=(key:string,fallback?:string)=>{const i=process.argv.indexOf(key);if(i<0){if(fallback!==undefined)return fallback;throw Error(`Provide ${key}`)}if(!process.argv[i+1])throw Error(`Provide ${key}`);return process.argv[i+1]}
const stages:Stage[]=['base','main','real','live']
const empty=()=>({closes:0,profit:0,loss:0,netPnl:0,netReturnSumPct:0,entries:0,additions:0,longEntries:0,shortEntries:0})
type Totals=ReturnType<typeof empty>
const measure=(s:Totals)=>({...s,...describeProfitFactor(s.profit,s.loss,s.closes),modeledOrderActions:s.entries+s.additions+s.closes})
const windowEmpty=()=>({samples:0,sets:0,profit:0,loss:0})
async function main(){
 const liveEntryMode=option('--live-entry-mode','independent') as EngineSettings['liveEntryMode']
 const realLastN=Number(option('--real-last-n','8')),futureRoot=process.argv.includes('--future-data')?resolve(option('--future-data')):null
 const futureManifest=futureRoot?JSON.parse(await readFile(join(futureRoot,'fresh-manifest.json'),'utf8')):null
 const input=resolve(option('--selection')),root=resolve(option('--data')),output=resolve(option('--output')),source=JSON.parse(await readFile(input,'utf8'))
 const variant=source.variants.find((v:any)=>v.name===option('--variant',source.variants[0].name));if(!variant)throw Error('Unknown frozen variant')
 const selected=variant.studies.flatMap((s:any)=>s.rows.filter((r:any)=>r.trainingPassed).map((row:any)=>({symbol:s.symbol,split:s.trainingCandles,row})))
 if(!selected.length)throw Error('No training-selected configurations')
 const feeds=new Map<string,Candle[]>(),datasets=[]
 for(const symbol of [...new Set<string>(selected.map((s:any)=>s.symbol))]){
  const raw=JSON.parse(await readFile(join(root,`${symbol}-10080.json`),'utf8')),hash=createHash('sha256').update(JSON.stringify(raw)).digest('hex'),declared=source.datasets.find((d:any)=>d.symbol===symbol)
  if(!declared||declared.sha256!==hash||raw.length!==declared.bars)throw Error('Frozen dataset digest mismatch')
  let all=raw
  if(futureRoot){
   const fresh=JSON.parse(await readFile(join(futureRoot,`${symbol}-fresh.json`),'utf8')),d=futureManifest.datasets.find((d:any)=>d.symbol===symbol)
   if(!d||d.bars!==fresh.length||d.sha256!==createHash('sha256').update(JSON.stringify(fresh)).digest('hex')||fresh[0].time!==raw.at(-1).time+60||fresh.some((c:any,i:number)=>i>0&&c.time!==fresh[i-1].time+60))throw Error('Fresh dataset digest or continuity mismatch')
   all=[...raw,...fresh];for(const item of selected)if(item.symbol===symbol)item.split=raw.length
  }
  feeds.set(symbol,all.map((c:any)=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume})));datasets.push(declared)
 }
 const results=[]
 for(const mode of ['continuous-ancestors','processed-sets'] as const){
  const started=performance.now(),totals=Object.fromEntries(stages.map(s=>[s,empty()])) as Record<Stage,Totals>,groups:Record<string,Totals>={},windows=Object.fromEntries(stages.map(s=>[s,windowEmpty()])),boundary=windowEmpty(),daily:Record<string,Totals>={},laneCounts=Object.fromEntries(stages.map(s=>[s,0])),enough=Object.fromEntries(stages.map(s=>[s,0])),livePnl:{time:number;id:string;value:number}[]=[]
  let engineMs=0,entriesWithRealLink=0,peakHeapBytes=0,unfinishedPositions=0
  for(const item of selected){
   const r=item.row,catalog={...source.settings,microTrailRatio:1,...source.fees[item.symbol],strategyTpSteps:[r.tpStep],strategySlRatios:[r.slRatio],strategyExitModes:[r.exitMode],strategyIndicationTypes:[r.tactic],...(r.indicationSourceId?{strategyIndicationSources:[r.indicationSourceId]}:{}),strategySignalPeriods:[r.lookback??20],strategySignalTimeframes:[r.signalTimeframeMinutes??1]}
   const engine=new TradingEngine({symbols:[item.symbol],stageGateMode:mode,liveEntryMode,stageLastN:{base:20,main:8,real:realLastN},catalog}),candles=feeds.get(item.symbol)!
   let t=performance.now();engine.processCandles(item.symbol,candles.slice(0,item.split),{eventLimit:0});engineMs+=performance.now()-t
   const trained=engine.exportState();for(const lane of Object.values(trained.lanes)){delete lane.open;if(lane.stage==='base'&&lane.samples.length>=trained.settings.stageLastN.base){const n=trained.settings.stageLastN.base,s=lane.samples.slice(0,n),profit=s.reduce((a,b)=>a+Math.max(0,b),0),loss=s.reduce((a,b)=>a+Math.max(0,-b),0);if(describeProfitFactor(profit,loss,s.length).profitFactor>=trained.settings.stageMinPF.base){boundary.samples+=n;boundary.sets++;boundary.profit+=profit;boundary.loss+=loss}}}
   const forward=new TradingEngine(trained.settings,trained)
   t=performance.now();const events=forward.processCandles(item.symbol,candles.slice(item.split));engineMs+=performance.now()-t
   for(const e of events){
    const row=totals[e.stage],key=`${e.stage}/${r.tactic}/${e.trade?.coordination??JSON.parse(e.laneId)[4]}`,g=groups[key]??=empty()
    if(e.type==='opened'){row.entries++;g.entries++;const direction=JSON.parse(e.laneId)[3];row[direction==='long'?'longEntries':'shortEntries']++;g[direction==='long'?'longEntries':'shortEntries']++}
    if(e.type==='added'){row.additions++;g.additions++}
    if(e.trade){const trade=e.trade;for(const target of [row,g]){target.closes++;target.profit+=Math.max(0,trade.netReturnPct);target.loss+=Math.max(0,-trade.netReturnPct);target.netPnl+=trade.netPnl;target.netReturnSumPct+=trade.netReturnPct}
     if(e.stage==='live'){if(mode==='processed-sets'&&!trade.parentPositionId)throw Error('Processed Live trade lacks Real link');if(trade.parentPositionId)entriesWithRealLink++;livePnl.push({time:trade.closedAt,id:trade.id,value:trade.netPnl});const d=daily[new Date(trade.closedAt).toISOString().slice(0,10)]??=empty();d.closes++;d.profit+=Math.max(0,trade.netReturnPct);d.loss+=Math.max(0,-trade.netReturnPct);d.netPnl+=trade.netPnl;d.netReturnSumPct+=trade.netReturnPct}
    }
   }
   const snapshot=forward.snapshot({positionLimit:0}),state=forward.exportState()
   for(const s of snapshot.stages){laneCounts[s.stage]+=s.currentLanes;enough[s.stage]+=s.currentEnoughSamples}
   for(const lane of snapshot.lanes)if(lane.qualified){const own=state.lanes[lane.id],w=windows[lane.stage];w.sets++;for(const v of own.samples.slice(0,lane.required)){w.samples++;w.profit+=Math.max(0,v);w.loss+=Math.max(0,-v)}}
   unfinishedPositions+=Object.values(state.lanes).filter(l=>l.open).length
   peakHeapBytes=Math.max(peakHeapBytes,process.memoryUsage().heapUsed)
   await new Promise<void>(r=>setImmediate(r))
  }
  let equity=10000,peak=equity,maxDrawdownPct=0;for(const p of livePnl.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id))){equity+=p.value;peak=Math.max(peak,equity);maxDrawdownPct=Math.max(maxDrawdownPct,100*(peak-equity)/peak)}
  const result={mode,liveEntryMode,stageLastN:{base:20,main:8,real:realLastN},configurations:selected.length,stages:Object.fromEntries(stages.map(s=>[s,{...measure(totals[s]),sets:laneCounts[s],enoughSamples:enough[s],enoughSamplesPct:laneCounts[s]?100*enough[s]/laneCounts[s]:null,validatedOwnWindow:{...windows[s],...describeProfitFactor(windows[s].profit,windows[s].loss,windows[s].samples)}}])),trainingBoundaryValidatedBase:{...boundary,...describeProfitFactor(boundary.profit,boundary.loss,boundary.samples)},modeledExecution:{...measure(totals.live),closedWithRealLink:entriesWithRealLink,equityStart:10000,equityEnd:equity,maxDrawdownPct,unfinishedPositions},groups:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,measure(v)])),dailyModeledExecution:Object.fromEntries(Object.entries(daily).map(([k,v])=>[k,measure(v)])),performance:{elapsedMs:performance.now()-started,engineMs,peakObservedHeapBytes:peakHeapBytes,processMaxRssKiB:process.resourceUsage().maxRSS}}
  results.push(result);console.log(JSON.stringify({mode,stages:result.stages,modeledExecution:result.modeledExecution,performance:result.performance}))
 }
 const outputData={kind:'cts-c-repeat-stage-simulation',generatedAt:new Date().toISOString(),selectionSha256:createHash('sha256').update(await readFile(input)).digest('hex'),variant:variant.name,datasets,futureDatasets:futureManifest?.datasets??null,forwardPhase:futureRoot?'next-day-frozen-candidates':'original-held-out-regression',ordersSubmitted:0,actualExchangeExecutionPF:null,results,methodology:(futureRoot?'Next-day replay: parameters stay frozen from the original training shortlist, all original seven days initialize past indicator and gate evidence, then fresh positions open exclusively in the subsequently downloaded completed candles. No next-day outcome selects a parameter. The original 65/35 split below describes parameter selection only. ':'')+'Frozen parameters selected on the first 65% of each seven-day observed market series. Each policy warms its own independent stage evidence on training only, discards all unfinished training positions, then opens new positions on the remaining 35%. Every held-out loss is retained. Live here is modeled execution at observed one-minute closes, not native exchange fills; modeledOrderActions counts entry, addition and close actions, excluding protection orders. All four coordination variants run as independent correlated lanes. PF uses net return on filled notional. Equity and drawdown use a declared 10,000-unit paper balance and default 1-unit lane budget, without exchange minimum sizes, funding, latency or native protective-fill simulation. Current validated own-window PF is selection evidence, separate from all admitted forward outcomes. This repeatedly researched period is retrospective regression evidence and cannot demonstrate stable future profitability. No venue writes or automatic settings promotion.'}
 await writeFile(output,JSON.stringify(outputData,null,2)+'\n')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Simulation failed');process.exitCode=1})
