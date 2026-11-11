/** 50-symbol chronological Micro/Low-Range study. No order writer; frozen train selection. */
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {BingxVstClient} from '../core/bingx'
import {getResearchCandles} from '../core/market'
import {runTerminalReplayAsync} from '../core/terminal-replay'
import {TradingEngine} from '../core/engine'
import {describeProfitFactor} from '../core/metrics'
import type {Candle,ClosedTrade,Stage} from '../core/types'

const index=process.argv.indexOf('--output'),directory=resolve(index<0?'.data/micro-study':process.argv[index+1])
const nIndex=process.argv.indexOf('--symbols'),count=nIndex<0?50:Number(process.argv[nIndex+1])
const empty=()=>({closes:0,profit:0,loss:0,pnl:0,notional:0,fees:0,entries:0,adds:0})
type Totals=ReturnType<typeof empty>
const result=(t:Totals)=>({...t,...describeProfitFactor(t.profit,t.loss,t.closes)})
function add(t:Totals,trade:ClosedTrade){t.closes++;t.profit+=Math.max(0,trade.netReturnPct);t.loss+=Math.max(0,-trade.netReturnPct);t.pnl+=trade.netPnl;t.notional+=trade.notional;t.fees+=trade.cost}
async function main(){
 await mkdir(directory,{recursive:true})
 let manifest:any
 try{manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'))}catch{
  const client=new BingxVstClient(),fee=await client.commission(),contracts=await client.contracts(),quotes=await client.quotes()
  const available=new Set(quotes.map(q=>q.symbol)),priority=['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','BCH-USDT','DOGE-USDT']
  manifest={createdAt:new Date().toISOString(),cutoff:Math.floor(Date.now()/60000)*60000,symbols:[...new Set([...priority,...contracts.map(c=>c.symbol)])].filter(s=>available.has(s)).slice(0,count),fee,barSeconds:60,bars:4320}
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2))
 }
 const settings={strategyEnabledRanges:['Micro','Low-Range'],strategyTpSteps:[2,3,4,5],strategySlRatios:Array.from({length:15},(_,i)=>(i+2)/10),strategyExitModes:['fixed','trailing','trailing-only'],strategyIndicationTypes:['MA_Cross','RSI_Band','Trend','Break'],strategySignalPeriods:[20],strategySignalTimeframes:[1],microTrailRatio:.5,autoPfEnabled:true,autoPfRatio:.2,autoPfMax:2,makerFeePct:manifest.fee.maker*100,takerFeePct:manifest.fee.taker*100,slippagePctOfFees:10,mainEvalPosCount:20,baseProfitFactor:1.1,replayBarSeconds:60}
 const rows:any[]=[],stages:Stage[]=['base','main','real','live'],all:Record<string,Totals>={},hourly:Record<string,Totals>={},groups:Record<string,Totals>={}
 const frozenSelections=new Map<string,any>(),refresh=process.argv.includes('--refresh-forward')
 try{const prior=JSON.parse(await readFile(join(directory,'results.json'),'utf8'));if(refresh){for(const row of prior.rows)frozenSelections.set(row.symbol,row.selection)}else{rows.push(...prior.rows);Object.assign(all,prior.stages);Object.assign(groups,prior.groups);Object.assign(hourly,prior.hourly)}}catch{if(refresh)throw Error('Forward refresh requires the original frozen study')}
 for(const symbol of manifest.symbols.filter((s:string)=>!rows.some(r=>r.symbol===s))){
  const started=performance.now(),file=join(directory,`${symbol}.json`);let raw:any[]
  try{raw=JSON.parse(await readFile(file,'utf8'))}catch{let failure:unknown;raw=[];for(let attempt=0;attempt<3;attempt++){try{raw=await getResearchCandles('bingx',symbol,'1m',true,manifest.bars,manifest.cutoff);break}catch(e){failure=e;console.log(JSON.stringify({symbol,fetchRetry:attempt+1}));await new Promise(r=>setTimeout(r,1000))}}if(!raw.length)throw failure;await writeFile(file,JSON.stringify(raw))}
  const data:Candle[]=raw.map(c=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}))
  const selection=frozenSelections.get(symbol)??await runTerminalReplayAsync(symbol,raw,settings),selected=selection.rows.filter((r:any)=>r.trainingPassed)
  const forward:any[]=[],boundary=selection.trainingCandles
  for(const row of selected){
   const catalog={...settings,strategyEnabledRanges:[row.range!],strategyTpSteps:[row.tpStep!],strategySlRatios:[row.slRatio!],strategyExitModes:[row.exitMode!],strategyIndicationTypes:[row.tactic]}
   const warm=new TradingEngine({symbols:[symbol],catalog,stageGateMode:'processed-sets',coordinations:{axis:{enabled:true,previous:5,last:2,outcome:'positive',reference:'base'},block:{enabled:true,steps:3,ratio:.2,mode:'additive',behavior:'rounds',size:3,pauseRounds:1,maxMultiplier:1.6},dca:{enabled:true,steps:2,distancePct:.2,multiplier:.2}}})
   warm.processCandles(symbol,data.slice(0,boundary),{eventLimit:0})
   const state=warm.exportState();for(const lane of Object.values(state.lanes))delete lane.open
   const engine=new TradingEngine(state.settings,state)
   const totals:Record<string,Totals>={}
   for(let offset=boundary;offset<data.length;offset+=120){
    for(const event of engine.processCandles(symbol,data.slice(offset,offset+120))){
     const key=event.stage,coord=JSON.parse(event.laneId)[4],gkey=`${row.range}/${row.tactic}/tp${row.tpStep}/sl${row.slRatio}/${row.exitMode}/${coord}/${key}`
     const targets=[totals[key]??=empty(),all[key]??=empty(),groups[gkey]??=empty()]
     if(event.type==='opened')for(const target of targets)target.entries++
     if(event.type==='added')for(const target of targets)target.adds++
     if(event.trade){for(const target of targets)add(target,event.trade);const hour=`${new Date(event.timestamp).toISOString().slice(0,13)}:00Z/${event.stage}`;add(hourly[hour]??=empty(),event.trade)}
    }
    await new Promise<void>(r=>setImmediate(r))
   }
   forward.push({config:row,stages:stages.map(stage=>({stage,...result(totals[stage]??empty())})),sampleCoverage:engine.snapshot({laneLimit:0,positionLimit:0}).stages,coordinations:engine.coordinationStats()})
  }
  const summary={symbol,bars:data.length,sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),selection,forward,elapsedMs:performance.now()-started}
  rows.push(summary);await writeFile(join(directory,`${symbol}-results.json`),JSON.stringify(summary))
  console.log(JSON.stringify({symbol,index:rows.length,configurations:selection.configurations,baseQualified:selection.eligible,selected:selected.length,sampleCoverage:selection.samplesPercent,elapsedMs:summary.elapsedMs}))
  await writeFile(join(directory,'results.json'),JSON.stringify({kind:'cts-c-micro-low-range-50',generatedAt:new Date().toISOString(),manifest,settings,completedSymbols:rows.length,stages:Object.fromEntries(stages.map(s=>[s,result(all[s]??empty())])),groups:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,result(v)])),hourly:Object.fromEntries(Object.entries(hourly).map(([k,v])=>[k,result(v)])),rows,ordersSubmitted:0,actualExecutionPF:null,methodology:'All Micro and Low-Range step 2–5 × SL/TP 0.2–1.6 in 0.1 increments × three exits × four indications are evaluated independently. First 65% ranks candidates; up to three per range are frozen before the remaining 35%. Selected candidates warm their own stage evidence on training, discard boundary open positions, then run new forward entries through Base/Main/Real/Live with independent Normal, Axis, Block-round and DCA lanes. All holdout losses retained. Actual account fees plus 10% fee-relative slippage once. Minutes give no intrabar ordering; 10s live observations are a separate dataset. No automatic defaults promotion or exchange writes.'}))
 }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Study failed');process.exitCode=1})
