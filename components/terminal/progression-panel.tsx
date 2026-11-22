"use client"

import { formatProfitFactor, type ProfitFactorState } from "./profit-factor"
import type { StageMetrics } from "@/core/types"
export interface StageTelemetry {autoPf?:StageMetrics["autoPf"];validatedWindow?:{samples:number;sets:number;profitFactor:number;pfState:ProfitFactorState};admittedForward?:{closes:number;profitFactor:number;pfState:ProfitFactorState;netPnl:number;unprovenCloses:number};executed?:{open:number;closed:number;profitFactor:number;pfState:ProfitFactorState;netPnl:number};directMirror?:boolean;sampleSetCount?:number;sets:number;allSets?:number;retiredSets?:number;eligible:number;enoughSamples:number|null;samplesPercent:number|null;pf:number|null;pfState?:ProfitFactorState;windowPF?:number|null;windowPfState?:ProfitFactorState;open?:number;closed?:number;blockedByParent?:number;admissionReady?:number;required?:number }
export const STAGE_NAMES = ["base","main","real","exec","live"] as const

export function ProgressionDetails({stages}:{stages:Record<string,StageTelemetry>}){
  return <section className="terminal-panel">
    <header className="terminal-panel-heading"><h2>Stage diagnostics</h2></header>
    <div className="terminal-table-wrap"><table className="terminal-table">
      <thead><tr>{["Stage","Current / retired Sets","Enough samples","Auto PF","Validated window PF","Admitted forward PF","Executed PF","Lifetime PF","Parent gate holds","Paper open / closed"].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{STAGE_NAMES.map(name=>{
        const s = stages[name]
        if (!s) return null
        return <tr key={name}>
          <th scope="row" className="uppercase">{name}</th>
          <td>{s.sets.toLocaleString()} / {(s.retiredSets??0).toLocaleString()}</td>
          <td>{s.directMirror ? "Direct mirror" : `${(s.enoughSamples??0).toLocaleString()} / ${(s.sampleSetCount??s.sets).toLocaleString()}`}{s.samplesPercent!=null&&<small>{s.samplesPercent.toFixed(1)}%{s.required!=null&&` · N=${s.required}`}</small>}</td>
          <td>{s.autoPf ? <>{s.autoPf.minThreshold.toFixed(2)}–{s.autoPf.maxThreshold.toFixed(2)}<small>{s.autoPf.historySets.toLocaleString()} history · {s.autoPf.fallbackSets.toLocaleString()} fallback</small></> : "—"}</td>
          <td>{formatProfitFactor(s.validatedWindow?.profitFactor,s.validatedWindow?.pfState)}{s.validatedWindow&&<small>{s.validatedWindow.sets.toLocaleString()} Sets · {s.validatedWindow.samples.toLocaleString()} samples</small>}</td>
          <td>{name==="base"?"—":formatProfitFactor(s.admittedForward?.profitFactor,s.admittedForward?.pfState)}{name!=="base"&&s.admittedForward&&<small>{s.admittedForward.closes.toLocaleString()} closes · {s.admittedForward.unprovenCloses.toLocaleString()} unproven</small>}</td>
          <td>{formatProfitFactor(s.executed?.profitFactor,s.executed?.pfState)}{s.executed&&<small>{s.executed.open.toLocaleString()} active · {s.executed.closed.toLocaleString()} settled</small>}</td>
          <td>{formatProfitFactor(s.pf,s.pfState)}</td>
          <td>{s.directMirror?"—":(s.blockedByParent??0).toLocaleString()}</td>
          <td>{(s.open??0).toLocaleString()} / {(s.closed??0).toLocaleString()}</td>
        </tr>
      })}</tbody>
    </table></div>
    <p className="terminal-ledger-note">Validated window PF uses qualified Sets. Forward PF includes every settled position admitted by its parent. Executed PF includes settled entries accepted at Exec. Active positions contribute to the open count until they close.</p>
  </section>
}

export function PaperEquity({history}:{history:{equity:number}[]}){
  if(history.length<2)return null
  const values=history.filter((_,i)=>i%Math.max(1,Math.floor(history.length/300))===0||i===history.length-1).map(p=>p.equity)
  const low=Math.min(...values),high=Math.max(...values),span=high-low||1
  const path=values.map((v,i)=>`${i?"L":"M"}${(i/(values.length-1)*680+10).toFixed(2)},${(150-(v-low)/span*130).toFixed(2)}`).join(" ")
  return <section className="terminal-panel"><header className="terminal-panel-heading"><div><p className="terminal-kicker">REALIZED LIVE-STAGE PAPER OUTCOMES</p><h2>Paper equity by close sequence</h2></div><span className="terminal-tag">{history.length.toLocaleString()} retained points</span></header><svg className="w-full h-44 px-4" viewBox="0 0 700 170" role="img" aria-label={`Paper equity changed from ${values[0].toFixed(2)} to ${values.at(-1)!.toFixed(2)} in recorded close order`}><path d={path} fill="none" stroke="var(--terminal-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg><p className="terminal-ledger-note">Settlement sequence across correlated paper lanes; excludes unrealized P&amp;L and funding. This is separate from exchange account equity.</p></section>
}
