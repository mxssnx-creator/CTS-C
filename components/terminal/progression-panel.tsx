"use client"

import { formatProfitFactor, type ProfitFactorState } from "./profit-factor"
export interface StageTelemetry { sets:number;allSets?:number;retiredSets?:number;eligible:number;enoughSamples:number|null;samplesPercent:number|null;pf:number|null;pfState?:ProfitFactorState;windowPF?:number;windowPfState?:ProfitFactorState;open?:number;closed?:number;blockedByParent?:number;admissionReady?:number;required?:number }

export function ProgressionDetails({stages}:{stages:Record<string,StageTelemetry>}){
  return <section className="terminal-panel"><header className="terminal-panel-heading"><div><p className="terminal-kicker">CURRENT CONFIGURATION / LIFETIME EVIDENCE</p><h2>Stage diagnostics</h2></div></header><div className="terminal-table-wrap"><table className="terminal-table"><thead><tr><th scope="col">Stage</th><th scope="col">Current / retired sets</th><th scope="col">Enough samples</th><th scope="col">Current windows PF</th><th scope="col">Lifetime PF</th><th scope="col">Parent gate holds</th><th scope="col">Paper open / closed</th></tr></thead><tbody>{["base","main","real","live"].map(name=>{const s=stages[name];return s?<tr key={name}><th scope="row" className="uppercase">{name}</th><td>{s.sets.toLocaleString()} / {(s.retiredSets??0).toLocaleString()}</td><td>{s.enoughSamples??"—"} / {s.sets}<small>{s.samplesPercent==null?"No current lanes":`${s.samplesPercent.toFixed(1)}% · N=${s.required??"—"}`}</small></td><td>{formatProfitFactor(s.windowPF,s.windowPfState)}</td><td>{formatProfitFactor(s.pf,s.pfState)}</td><td>{s.blockedByParent??0}</td><td>{s.open??0} / {(s.closed??0).toLocaleString()}</td></tr>:null})}</tbody></table></div><p className="terminal-ledger-note">Current windows include wins and losses from the selected configuration. Lifetime PF includes retired cohorts. Main, Real and Live require their preceding stage gates to remain qualified; Live entry readiness uses Real evidence.</p></section>
}

export function PaperEquity({history}:{history:{equity:number}[]}){
  if(history.length<2)return null
  const values=history.filter((_,i)=>i%Math.max(1,Math.floor(history.length/300))===0||i===history.length-1).map(p=>p.equity)
  const low=Math.min(...values),high=Math.max(...values),span=high-low||1
  const path=values.map((v,i)=>`${i?"L":"M"}${(i/(values.length-1)*680+10).toFixed(2)},${(150-(v-low)/span*130).toFixed(2)}`).join(" ")
  return <section className="terminal-panel"><header className="terminal-panel-heading"><div><p className="terminal-kicker">REALIZED LIVE-STAGE PAPER OUTCOMES</p><h2>Paper equity by close sequence</h2></div><span className="terminal-tag">{history.length.toLocaleString()} retained points</span></header><svg className="w-full h-44 px-4" viewBox="0 0 700 170" role="img" aria-label={`Paper equity changed from ${values[0].toFixed(2)} to ${values.at(-1)!.toFixed(2)} in recorded close order`}><path d={path} fill="none" stroke="var(--terminal-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg><p className="terminal-ledger-note">Settlement sequence across correlated paper lanes; excludes unrealized P&amp;L and funding. This is separate from exchange account equity.</p></section>
}
