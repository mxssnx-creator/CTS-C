/** Retrospective nested training selection. Uses the actual CTS-C engine; no exchange client. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
const option=k=>{const i=process.argv.indexOf(k);if(i<0||!process.argv[i+1])throw Error('Provide '+k);return resolve(process.argv[i+1])}
const {TradingEngine}=await import(new URL('../core/engine.ts',import.meta.url).href)
const source=JSON.parse(await readFile(option('--selection'),'utf8')),root=option('--data'),output=option('--output')
const empty=()=>Object.fromEntries(['base','main','real','live'].map(s=>[s,{closes:0,profit:0,loss:0,netSumPct:0}]))
function add(rows,events){for(const e of events)if(e.trade){const r=rows[e.stage],v=e.trade.netReturnPct;r.closes++;r.profit+=Math.max(0,v);r.loss+=Math.max(0,-v);r.netSumPct+=v}}
const metrics=rows=>Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,{...v,pf:v.loss?v.profit/v.loss:null,pfState:v.loss?'finite':v.closes?'no-losses':'empty'}]))
const selected=source.variants[0].studies.flatMap(s=>s.rows.filter(r=>r.trainingPassed).map(row=>({symbol:s.symbol,split:s.trainingCandles,row})))
const candles={};for(const item of selected)if(!candles[item.symbol]){const raw=JSON.parse(await readFile(join(root,item.symbol+'-10080.json'),'utf8')),declared=source.datasets.find(d=>d.symbol===item.symbol);if(!declared||declared.sha256!==createHash('sha256').update(JSON.stringify(raw)).digest('hex')||declared.bars!==raw.length)throw Error('Frozen dataset digest mismatch');candles[item.symbol]=raw.map(c=>({...c,timestamp:(c.time+60)*1000}))}
const capacity=process.argv.includes('--live-capacity')
const profiles=[]
for(const [base,main,real] of capacity?[1,2,3,4,5,8].map(real=>[20,8,real]):[[20,8,8],[12,5,5],[12,3,3],[20,5,5],[30,5,5],[30,3,3],[8,3,3]])for(const mode of capacity?['all']:['normal','axis','block','all'])profiles.push({base,main,real,mode})
const results=[];let bestScore=-Infinity,bestStates,best
for(const profile of profiles){
 const totals=empty(),states=[]
 for(const item of selected){
  const r=item.row,catalog={...source.settings,...source.fees[item.symbol],strategyTpSteps:[r.tpStep],strategySlRatios:[r.slRatio],strategyExitModes:[r.exitMode],strategyIndicationTypes:[r.tactic],strategySignalPeriods:[r.lookback??20],strategySignalTimeframes:[r.signalTimeframeMinutes??1]}
  const engine=new TradingEngine({stageGateMode:process.argv.includes('--processed')?'processed-sets':'continuous-ancestors',liveEntryMode:capacity?'real-mirror':'independent',symbols:[item.symbol],catalog,stageLastN:{base:profile.base,main:profile.main,real:profile.real},coordinations:{axis:{enabled:profile.mode==='axis'||profile.mode==='all',previous:capacity?8:5,last:capacity?3:2,outcome:'any',reference:capacity?'same-stage':'base'},block:{enabled:profile.mode==='block'||profile.mode==='all',steps:3,ratio:capacity?.2:.1,mode:'shared'},dca:{enabled:profile.mode==='all',steps:2,distancePct:1,multiplier:2}}})
  add(totals,engine.processCandles(item.symbol,candles[item.symbol].slice(0,item.split)))
  const state=engine.exportState();for(const lane of Object.values(state.lanes))delete lane.open
  states.push({item,state})
 }
 const scored=metrics(totals),stages=['main','real','live'],enough=stages.every(s=>scored[s].closes>=20&&scored[s].pf!==null),score=enough?Math.min(...stages.map(s=>scored[s].pf)):-Infinity
 const row={profile,training:scored,enoughTraining:enough,trainingQualified:enough&&score>=1.1,trainingWorstPostBasePF:Number.isFinite(score)?score:null};results.push(row)
 if(score>bestScore){bestScore=score;best=row;bestStates=states}
 console.log(JSON.stringify({profile,training:scored,selectedSoFar:best?.profile??null}))
 await new Promise(r=>setImmediate(r))
}
let holdout=null
if(bestStates){const totals=empty(),byType={};for(const {item,state} of bestStates){const engine=new TradingEngine(state.settings,state),events=engine.processCandles(item.symbol,candles[item.symbol].slice(item.split));add(totals,events);add(byType[item.row.tactic]??=empty(),events)}holdout={overall:metrics(totals),byType:Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,metrics(v)]))}}
const result={kind:'training-selected-stage-coordination-profile-study',liveCapacityStudy:capacity,stageGateMode:process.argv.includes('--processed')?'processed-sets':'continuous-ancestors',generatedAt:new Date().toISOString(),ordersSubmitted:0,automaticPromotion:false,configurations:selected.length,profiles:results,bestTraining:best??null,holdout,methodology:'Distance/indication candidates and gate/coordination profile are selected using the first 65% only. The profile score is the worst Main/Real/Live training PF, requiring at least 20 closes at each stage. Exactly one training-ranked profile is evaluated on the remaining 35%; unfinished training positions are discarded, own-stage evidence and signal history are retained. All subsequent holdout losses are retained. This already-studied historical period is retrospective regression evidence, not untouched future validation. No automatic settings promotion or exchange writer.'}
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:true,bestTraining:best?.profile,holdout:holdout?.overall}))
