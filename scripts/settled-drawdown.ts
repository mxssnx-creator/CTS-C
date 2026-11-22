/** Realized cash-PnL drawdown, with all closes at one clock applied together. */
export function settledDrawdown(flows: readonly (readonly [number,number])[]) {
 const byClock=new Map<number,number>()
 for(const [at,pnl] of flows){
  if(!Number.isFinite(at)||!Number.isFinite(pnl))throw new Error('Invalid settled PnL observation')
  const total=(byClock.get(at)??0)+pnl
  if(!Number.isFinite(total))throw new Error('Invalid settled PnL observation')
  byClock.set(at,total)
 }
 let netPnl=0,peak=0,peakToTrough=0
 for(const [,pnl] of [...byClock.entries()].sort(([a],[b])=>a-b)){
  netPnl+=pnl
  if(!Number.isFinite(netPnl))throw new Error('Invalid settled PnL observation')
  peak=Math.max(peak,netPnl);peakToTrough=Math.max(peakToTrough,peak-netPnl)
  if(!Number.isFinite(peakToTrough))throw new Error('Invalid settled PnL observation')
 }
 return {netPnl,peakToTrough,clocks:byClock.size}
}
