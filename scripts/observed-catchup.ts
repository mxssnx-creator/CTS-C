/** Read-only, fixed-cutoff replay of a private checkpoint using observed VST candles. */
import { writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { BingxVstClient } from "../core/bingx"
import { TradingEngine } from "../core/engine"
import { closedHistory, planHistory, validateHistory } from "../core/history"
import { describeProfitFactor } from "../core/metrics"
import type { Stage } from "../core/types"

function option(name:string):string {
  const index=process.argv.indexOf(name), value=index<0?undefined:process.argv[index+1]
  if(!value||value.startsWith("--"))throw new Error(`Provide ${name}`)
  return value
}

async function main(){
  const database=new DatabaseSync(option("--db"),{readOnly:true})
  const row=database.prepare("SELECT data FROM records WHERE key='engine'").get() as {data:string}|undefined
  database.close()
  if(!row)throw new Error("Checkpoint has no engine state")
  const engine=TradingEngine.fromSerialized(row.data)
  row.data=""
  const before=engine.snapshot({laneLimit:0,positionLimit:0})
  const client=new BingxVstClient(null), venueNow=await client.clock()
  const endIndex=process.argv.indexOf("--end"), requestedEnd=endIndex<0?venueNow:Date.parse(option("--end"))
  if(!Number.isFinite(requestedEnd)||requestedEnd>venueNow)throw new Error("--end must be a valid non-future timestamp")
  const cutoff=Math.floor(requestedEnd/60_000)*60_000
  const results:{symbol:string;bars:number;status:string;error?:string}[]=[]
  const period=Object.fromEntries((["base","main","real","live"] as Stage[]).map(stage=>[stage,{closed:0,profit:0,loss:0,netPnl:0}])) as Record<Stage,{closed:number;profit:number;loss:number;netPnl:number}>
  for(const symbol of engine.settings.symbols){
    let bars=0
    try{
      for(;;){
        const cursor=engine.lastProcessedAt(symbol), plan=planHistory(1440,cursor,cutoff)
        if(cursor===plan.cutoff)break
        const candles=await closedHistory(client,symbol,plan.count,plan.cutoff)
        validateHistory(symbol,candles,plan)
        bars+=candles.filter(c=>cursor===null||c.timestamp>cursor).length
        for(const event of engine.processCandles(symbol,candles,{allowExecution:false})){
          if(event.type!=="closed"||!event.trade)continue
          const stats=period[event.stage], result=event.trade.netReturnPct
          stats.closed++;stats.profit+=Math.max(0,result);stats.loss+=Math.max(0,-result);stats.netPnl+=event.trade.netPnl
        }
        if(plan.cutoff===cutoff)break
      }
      results.push({symbol,bars,status:"complete"})
    }catch(error){results.push({symbol,bars,status:"unavailable",error:error instanceof Error?error.message:"History unavailable"})}
    if(results.length%10===0)console.log(JSON.stringify({progress:results.length,total:engine.settings.symbols.length,complete:results.filter(r=>r.status==="complete").length}))
  }
  const after=engine.snapshot({laneLimit:0,positionLimit:0})
  const replayed=after.stages.map(stage=>{
    const stats=period[stage.stage], prior=before.stages.find(item=>item.stage===stage.stage)!
    if(stage.closed-prior.closed!==stats.closed)throw new Error(`Close-count mismatch in ${stage.stage} catch-up`)
    return {stage:stage.stage,closed:stats.closed,...describeProfitFactor(stats.profit,stats.loss,stats.closed),netPnl:stats.netPnl}
  })
  const report={kind:"observed-vst-checkpoint-catchup",generatedAt:new Date().toISOString(),cutoff:new Date(cutoff).toISOString(),
    ordersSubmitted:0,execution:"disabled; no exchange writer instantiated",symbols:results.length,complete:results.filter(r=>r.status==="complete").length,
    bars:results.reduce((sum,r)=>sum+r.bars,0),pendingIntentsBefore:before.intents.filter(i=>i.status==="pending").length,pendingIntentsAfter:after.intents.filter(i=>i.status==="pending").length,
    before:before.stages,after:after.stages,replayed,results}
  await writeFile(option("--output"),JSON.stringify(report,null,2)+"\n",{mode:0o600})
  console.log(JSON.stringify({complete:report.complete,symbols:report.symbols,bars:report.bars,ordersSubmitted:0,pendingIntentsAfter:report.pendingIntentsAfter,replayed:report.replayed,stages:report.after}))
  if(report.complete!==report.symbols)process.exitCode=1
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Observed catch-up failed");process.exitCode=1})
