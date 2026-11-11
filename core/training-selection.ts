import {describeProfitFactor} from './metrics'
import type {LaneState,StrategyConfig} from './types'

/** Freeze a research cohort from completed prehistory only, before any forward candle is consumed. */
export function selectTrainingConfigurations(lanes:Iterable<LaneState>,configs:readonly StrategyConfig[],symbol:string,minSamples=20,minPF=1.1,perRange=3){
  if(!symbol||configs.some(c=>!c.range))throw Error('Prehistory selection requires one symbol and explicit configuration ranges')
  if(!Number.isInteger(minSamples)||minSamples<1||!Number.isFinite(minPF)||minPF<1||!Number.isInteger(perRange)||perRange<1)throw Error('Invalid prehistory selection policy')
  const scores=new Map(configs.map(c=>[c.id,{id:c.id,connectionId:c.connectionId,range:c.range!,type:c.type,source:c.indicationSourceId??c.type,closes:0,profit:0,loss:0}]))
  for(const lane of lanes){const row=scores.get(lane.configId);if(row&&lane.symbol===symbol&&lane.config.connectionId===row.connectionId&&lane.stage==='base'&&lane.coordination==='normal'){row.closes+=lane.closedCount;row.profit+=lane.grossProfit;row.loss+=lane.grossLoss}}
  const rows=[...scores.values()].map(r=>({...r,...describeProfitFactor(r.profit,r.loss,r.closes),enoughSamples:r.closes>=minSamples,qualified:r.closes>=minSamples&&describeProfitFactor(r.profit,r.loss,r.closes).profitFactor>=minPF}))
  const ranked=rows.filter(r=>r.qualified).sort((a,b)=>b.profitFactor-a.profitFactor||(b.profit-b.loss)-(a.profit-a.loss)||a.id.localeCompare(b.id)),counts=new Map<string,number>()
  const selected=ranked.filter(r=>{const n=counts.get(r.range)??0;counts.set(r.range,n+1);return n<perRange})
  return {minSamples,minPF,perRange,selectionBasis:'all completed prehistory Base/Normal outcomes, both directions; top per range within each indication family',candidates:rows,selectedIds:selected.map(r=>r.id)}
}
