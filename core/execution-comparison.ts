import {describeProfitFactor} from './metrics'
import type {ClosedTrade} from './types'

export interface ComparisonLot {id:string;connectionId:string;laneId:string;symbol:string;direction:'long'|'short';quantity:number;openedQuantity:number;openedNotional?:number;averageEntry:number;realizedGrossPnl:number;realizedNetPnl:number|null;fees:number|null;externalClosure?:{confirmedAt?:number};executionIntent:{positionId:string;qualificationId?:string}}
/** Exact position identity, identical paired cohorts, signed real fees once. Missing data stays unavailable. */
export function executionComparison(lots:readonly ComparisonLot[],simulations:ReadonlyMap<string,ClosedTrade>,limit=200){
 const rows:ReturnType<typeof row>[]=[];let matched=0,paperProfit=0,paperLoss=0,liveProfit=0,liveLoss=0,sumDelta=0,better=0,incomplete=0,awaitingSimulation=0,open=0,externalCloses=0
 const deltas:number[]=[]
 function row(lot:ComparisonLot){
  const paper=simulations.get(JSON.stringify([lot.connectionId,lot.executionIntent.positionId])),notional=lot.openedNotional
  const status=lot.quantity>1e-10?'open':!paper?'awaiting-simulation':lot.realizedNetPnl===null||lot.fees===null||!notional?'incomplete-exchange':'matched'
  const liveReturn=status==='matched'?100*lot.realizedNetPnl!/notional!:null,simReturn=paper?.netReturnPct??null
  const feeDelta=status==='matched'?100*lot.fees!/notional!-100*paper!.cost/paper!.notional:null
  const delta=liveReturn!==null&&simReturn!==null?liveReturn-simReturn:null
  const entrySlippageBps=paper&&notional&&lot.openedQuantity>0?(lot.direction==='long'?1:-1)*(notional/lot.openedQuantity/paper.entryPrice-1)*10000:null
  return {id:lot.id,positionId:lot.executionIntent.positionId,laneId:lot.laneId,symbol:lot.symbol,direction:lot.direction,configId:paper?.configId??null,coordination:paper?.coordination??null,status,simulatedReturnPct:simReturn,exchangeReturnPct:liveReturn,deltaPp:delta,feeDeltaPp:feeDelta,entrySlippageBps,quantityRatio:paper?lot.openedQuantity/paper.quantity:null,expectedNetAtActualNotional:paper&&notional?paper.netReturnPct/100*notional:null,exchangeNetPnl:lot.realizedNetPnl,closedAt:paper?.closedAt??null,externalClose:!!lot.externalClosure?.confirmedAt}
 }
 for(const lot of lots){
  if(!lot.executionIntent.qualificationId)continue
  const r=row(lot);externalCloses+=Number(r.externalClose)
  if(r.status==='matched'){matched++;paperProfit+=Math.max(0,r.simulatedReturnPct!);paperLoss+=Math.max(0,-r.simulatedReturnPct!);liveProfit+=Math.max(0,r.exchangeReturnPct!);liveLoss+=Math.max(0,-r.exchangeReturnPct!);sumDelta+=r.deltaPp!;better+=Number(r.deltaPp!>=0);deltas.push(r.deltaPp!)}
  else if(r.status==='open')open++;else if(r.status==='awaiting-simulation')awaitingSimulation++;else incomplete++
  rows.push(r)
 }
 deltas.sort((a,b)=>a-b)
 const total=matched+open+awaitingSimulation+incomplete
 return {scope:'qualified-owned-position-pairs',matched,open,awaitingSimulation,incomplete,externalCloses,coveragePct:total?100*matched/total:null,simulatedPF:{closed:matched,...describeProfitFactor(paperProfit,paperLoss,matched)},exchangePF:{closed:matched,...describeProfitFactor(liveProfit,liveLoss,matched)},meanDeltaPp:matched?sumDelta/matched:null,medianDeltaPp:matched?(deltas[Math.floor((matched-1)/2)]+deltas[Math.floor(matched/2)])/2:null,notWorsePct:matched?100*better/matched:null,sampleReady:matched>=8,minimumSamples:8,rows:rows.sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,limit),rowsTotal:total,rowsLimit:limit}
}
