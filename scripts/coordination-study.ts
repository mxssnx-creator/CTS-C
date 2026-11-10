/** Frozen train-selected parameters; paired same-entry controls and equal budget. No exchange writer. */
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {TradingEngine} from '../core/engine'
import {observedExit} from '../core/exits'
import {generateStrategyCatalog} from '../core/catalog'
import {replayStrategy} from '../core/replay'
import {aggregateCostNormalizedResults,describeProfitFactor} from '../core/metrics'
import type {Candle,PaperPosition,Stage,Coordination} from '../core/types'
function option(key:string){const i=process.argv.indexOf(key);if(i<0||!process.argv[i+1])throw Error(`Provide ${key}`);return path.resolve(process.argv[i+1])}
type Sums={count:number;profit:number;loss:number}
const empty=():Sums=>({count:0,profit:0,loss:0})
function add(s:Sums,value:number){s.count++;s.profit+=Math.max(0,value);s.loss+=Math.max(0,-value)}
function measured(s:Sums){return {closes:s.count,...describeProfitFactor(s.profit,s.loss,s.count)}}
async function main(){
 const source=JSON.parse(await readFile(option('--selection'),'utf8')),root=option('--data'),output=option('--output')
 const variants=[{name:'normal',target:'normal' as Coordination},...(['same-stage','base'] as const).flatMap(reference=>([ [8,3],[5,2],[3,1] ]).flatMap(([previous,last])=>(['any','positive','negative'] as const).map(outcome=>({name:`axis-${reference}-${outcome}-${previous}-${last}`,target:'axis' as Coordination,outcome,previous,last,reference})))),...(['shared','additive'] as const).flatMap(mode=>[.1,.2,.4].map(ratio=>({name:`block-${mode}-${ratio}`,target:'block' as Coordination,mode,ratio})))]
 const result=[]
 const inputs=source.variants.find((v:any)=>v.name==='core').studies
 for(const variant of variants){
  const stages=Object.fromEntries((['base','main','real','live'] as Stage[]).map(stage=>[stage,{actual:empty(),control:empty(),paired:empty(),pairedBudget:empty(),pairedControl:empty(),censored:0}])) as Record<Stage,{actual:Sums;control:Sums;paired:Sums;pairedBudget:Sums;pairedControl:Sums;censored:number}>
  const groups:Record<string,{actual:Sums;pairedBudget:Sums;control:Sums}>={}
  let configurations=0
  for(const selection of inputs){
   const raw=JSON.parse(await readFile(path.join(root,`${selection.symbol}-10080.json`),'utf8'))
   const candles:Candle[]=raw.map((c:any)=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume})),split=selection.trainingCandles
   for(const row of selection.rows.filter((r:any)=>r.trainingPassed)){
    const catalog={...source.settings,...source.fees[selection.symbol],strategyTpSteps:[row.tpStep],strategySlRatios:[row.slRatio],strategyExitModes:[row.exitMode],strategyIndicationTypes:[row.tactic]}
    const config=generateStrategyCatalog('compare',catalog)[0]
    const old=replayStrategy(selection.symbol,candles.slice(0,split),config,split*2).filter(p=>p.status==='closed').map(p=>p.result!)
    const score=aggregateCostNormalizedResults(old)
    if(old.length!==row.training.trades||Math.abs(score.profitFactor-row.training.pf)>1e-8)throw Error('Frozen training selection no longer matches the normal exit model')
    const coordinations={axis:{reference:'reference' in variant?variant.reference:'same-stage' as const,enabled:variant.target==='axis',previous:'previous' in variant?variant.previous:8,last:'last' in variant?variant.last:3,outcome:'outcome' in variant?variant.outcome:'any' as const},block:{enabled:variant.target==='block',steps:3,ratio:'ratio' in variant?variant.ratio:.2,mode:'mode' in variant?variant.mode:'shared' as const},dca:{enabled:false,steps:2,distancePct:1,multiplier:2}}
    const warm=new TradingEngine({connectionId:'compare',symbols:[selection.symbol],catalog,coordinations})
    warm.processCandles(selection.symbol,candles.slice(0,split));const state=warm.exportState();for(const lane of Object.values(state.lanes))delete lane.open
    const engine=new TradingEngine(state.settings,state)
    const pairs=new Map<string,{stage:Stage;control:PaperPosition;budget:number;actual?:number;actualBudget?:number;baseline?:number;closed?:boolean}>()
    for(const candle of candles.slice(split)){
     for(const pair of pairs.values()){
      if(pair.closed||candle.timestamp<=pair.control.openedAt)continue
      const exit=observedExit({...pair.control,price:candle.close,timestamp:candle.timestamp})
      pair.control.peak=exit.peak;pair.control.trailingActive=exit.trailingActive;pair.control.trailingStopPrice=exit.stop
      if(exit.reason){const sign=pair.control.direction==='long'?1:-1;pair.baseline=(sign*(candle.close-pair.control.entryPrice)*pair.control.quantity-pair.budget*pair.control.costPct/100)/pair.budget*100;pair.closed=true;add(stages[pair.stage].control,pair.baseline)}
     }
     const events=engine.processCandles(selection.symbol,[candle])
     const opens=events.some(e=>e.type==='opened')?new Map(engine.snapshot({laneLimit:0}).positions.map(p=>[p.laneId,p])):new Map()
     for(const event of events){
      if(event.type==='opened'){
       const p=opens.get(event.laneId);if(!p||p.coordination!==variant.target)continue
       const budget=p.sizing!.baseBudget
       pairs.set(p.id,{stage:p.stage,budget,control:{...p,notional:budget,quantity:budget/p.entryPrice,fills:[{price:p.entryPrice,quantity:budget/p.entryPrice,timestamp:p.openedAt,kind:'entry'}]}})
      }
      if(event.trade?.coordination===variant.target){
       const t=event.trade,pair=pairs.get(t.id);add(stages[t.stage].actual,t.netReturnPct)
       const key=`${row.range}/${row.tactic}/tp${row.tpStep}/${row.exitMode}/${t.stage}`,g=groups[key]??={actual:empty(),pairedBudget:empty(),control:empty()};add(g.actual,t.netReturnPct)
       if(pair){pair.actual=t.netReturnPct;pair.actualBudget=t.netPnl/pair.budget*100}
      }
     }
    }
    for(const pair of pairs.values()){
     if(pair.actual===undefined||pair.baseline===undefined){stages[pair.stage].censored++;continue}
     const s=stages[pair.stage];add(s.paired,pair.actual);add(s.pairedBudget,pair.actualBudget!);add(s.pairedControl,pair.baseline)
     const key=`${row.range}/${row.tactic}/tp${row.tpStep}/${row.exitMode}/${pair.stage}`,g=groups[key]??={actual:empty(),pairedBudget:empty(),control:empty()};add(g.pairedBudget,pair.actualBudget!);add(g.control,pair.baseline)
     if(variant.target==='normal'||variant.target==='axis')if(Math.abs(pair.actual!-pair.baseline)>1e-8)throw Error('Pure filtering/sizing changed a matched-entry return')
    }
    configurations++
   }
  }
  const summary=Object.entries(stages).map(([stage,s])=>({stage,actual:measured(s.actual),matchedReturnPF:measured(s.paired),matchedBudgetPF:measured(s.pairedBudget),matchedWithout:measured(s.pairedControl),censoredPairs:s.censored}))
  result.push({variant,configurations,stages:summary,groups:Object.entries(groups).map(([key,g])=>({key,actual:measured(g.actual),matchedBudgetPF:measured(g.pairedBudget),without:measured(g.control)}))})
  console.log(JSON.stringify({variant:variant.name,configurations,stages:summary}))
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 await writeFile(output,JSON.stringify({kind:'axis-block-frozen-matched-budget-comparison',generatedAt:new Date().toISOString(),ordersSubmitted:0,sourceDatasets:source.datasets,methodology:'Parameters are frozen from the preceding core training selection. Both completed matched-entry controls and incomplete/censored pairs are reported. Controls use the same entry, observed candles, cost, exit terms and full reserved base budget, with no additions. Actual candidate lanes use their own stage evidence. Matched budget PF normalizes both sides by reserved budget; ordinary candidate PF normalizes filled notional. Axis filtering can change its unpaired cohort but a pure size factor cannot manufacture PF. This is retrospective regression evidence, not an untouched live profitability claim.',result},null,2)+'\n')
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Coordination comparison failed');process.exitCode=1})
