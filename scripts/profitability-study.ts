/** Fixed data, declared candidates, training-only ranking; no exchange writer. */
import { createHash } from "node:crypto"
import { mkdir,readFile,writeFile } from "node:fs/promises"
import path from "node:path"
import { getResearchCandles,type MarketCandle } from "../core/market"
import { CORE_INDICATIONS, INDICATIONS } from "../core/indications"
import { runTerminalReplayAsync } from "../core/terminal-replay"
import { describeProfitFactor } from "../core/metrics"
import { replayStrategy } from "../core/replay"
import { generateStrategyCatalog } from "../core/catalog"
import { BingxVstClient,demoCredentials } from "../core/bingx"
import { TradingEngine } from "../core/engine"

const symbols=["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","BCH-USDT","DOGE-USDT"]
const cutoff=Date.parse("2026-11-10T17:00:00Z"),barsIndex=process.argv.indexOf('--bars'),count=barsIndex<0?5000:Number(process.argv[barsIndex+1])
function option(name:string){const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error(`Provide ${name}`);return path.resolve(process.argv[i+1])}
async function main(){
  const directory=option("--data"),output=option("--output")
  if(!Number.isInteger(count)||count<100||count>20000)throw new Error('Study bars must be 100..20000')
  await mkdir(directory,{recursive:true})
  const feeds:Record<string,MarketCandle[]>={},datasets:unknown[]=[]
  for(const symbol of symbols){
    const filename=path.join(directory,`${symbol}-${count}.json`)
    let candles:MarketCandle[]
    try{candles=JSON.parse(await readFile(filename,"utf8"))}catch{
      candles=[];let end=cutoff
      while(candles.length<count){const batch=await getResearchCandles("bingx",symbol,"1m",true,Math.max(100,Math.min(5000,count-candles.length)),end);candles=[...batch,...candles];end=batch[0].time*1000}
      candles=candles.slice(-count);await writeFile(filename,JSON.stringify(candles)+"\n")
    }
    if(candles.length!==count||candles.at(-1)!.time*1000+60_000!==cutoff||candles.some((c,i)=>i>0&&c.time-candles[i-1].time!==60))throw new Error(`Invalid frozen data for ${symbol}`)
    feeds[symbol]=candles;datasets.push({symbol,bars:candles.length,firstOpen:candles[0].time,lastClose:cutoff/1000,sha256:createHash("sha256").update(JSON.stringify(candles)).digest("hex")})
    console.log(JSON.stringify({event:"dataset-ready",symbol,bars:candles.length}))
  }
  const settings={strategyTpSteps:[3,8,12,18,24,30],strategySlRatios:[.6,1,1.4],strategyExitModes:["fixed","trailing","trailing-only"],mainEvalPosCount:20,baseProfitFactor:1.1,makerFeePct:.05,takerFeePct:.08,slippagePctOfFees:10,replayBarSeconds:60}
  const fees:Record<string,{makerFeePct:number;takerFeePct:number}>={}
  if(process.argv.includes('--account-fees')){
    const credentials=demoCredentials();if(!credentials)throw new Error('Dedicated x02 commission credentials required')
    const client=new BingxVstClient(credentials)
    for(const symbol of symbols){const fee=await client.commission(symbol);fees[symbol]={makerFeePct:Math.max(0,fee.maker*100),takerFeePct:fee.taker*100}}
  }
  const variants=[]
  for(const [name,types] of [["core",CORE_INDICATIONS],["expanded",INDICATIONS]] as const){
    const studies=[], outcomes:number[]=[],forward=[]
    for(const symbol of symbols){
      const symbolSettings={...settings,...fees[symbol],strategyIndicationTypes:[...types]}
      const candles=feeds[symbol], study=await runTerminalReplayAsync(symbol,candles,symbolSettings)
      const split=study.trainingCandles, train=candles.slice(0,split).map(c=>({...c,timestamp:(c.time+60)*1000})),test=candles.slice(split).map(c=>({...c,timestamp:(c.time+60)*1000}))
      const configs=new Map(generateStrategyCatalog("study",symbolSettings).map(c=>[c.id,c]))
      const selected=study.rows.filter(r=>r.trainingPassed)
      for(const row of selected){
        const config=configs.get(row.id)!
        outcomes.push(...replayStrategy(symbol,test,config,test.length*2,train).filter(p=>p.status==="closed").map(p=>p.result!))
        const catalog={...symbolSettings,strategyTpSteps:[config.tpStep!],strategySlRatios:[config.slRatio!],strategyExitModes:[config.exitMode!],strategyIndicationTypes:[config.type]}
        const warm=new TradingEngine({symbols:[symbol],catalog})
        const toBar=(c:MarketCandle)=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume})
        warm.processCandles(symbol,candles.slice(0,split).map(toBar))
        const state=warm.exportState();for(const lane of Object.values(state.lanes))delete lane.open
        const engine=new TradingEngine(state.settings,state), period:Record<string,{closed:number;profit:number;loss:number}>={}
        for(const event of engine.processCandles(symbol,candles.slice(split).map(toBar))){if(event.trade){const key=`${event.stage}/${event.trade.coordination}`,s=period[key]??={closed:0,profit:0,loss:0};s.closed++;s.profit+=Math.max(0,event.trade.netReturnPct);s.loss+=Math.max(0,-event.trade.netReturnPct)}}
        forward.push({symbol,configId:config.id,stageLastN:engine.settings.stageLastN,period,stages:engine.snapshot({laneLimit:0,positionLimit:0}).stages})
      }
      studies.push({...study,selectionCount:selected.length})
      console.log(JSON.stringify({event:"study-ready",variant:name,symbol,trainingQualified:study.eligible,selected:selected.length}))
    }
    const profit=outcomes.reduce((sum,v)=>sum+Math.max(0,v),0),loss=outcomes.reduce((sum,v)=>sum+Math.max(0,-v),0)
    variants.push({name,studies,forward,heldout:{...describeProfitFactor(profit,loss,outcomes.length),closes:outcomes.length,netReturnSumPct:profit-loss}})
  }
  const result={kind:"frozen-observed-vst-training-holdout",generatedAt:new Date().toISOString(),ordersSubmitted:0,datasets,settings,fees,feeSource:process.argv.includes('--account-fees')?'per-symbol x02 commission GET plus modeled 10% fee-relative slippage':'configured fallback',variants,methodology:"Two declared catalogs, identical data and costs. The first 65% ranks candidates; up to three per range with >=20 closes and PF>=1.1 are frozen before the remaining 35%. All selected holdout losses are retained. Selected candidates also run through the actual Base/Main/Real/Live engine and all four coordinations: train-only lane evidence is retained, all simulated training positions are discarded at the boundary, and holdout positions start fresh. Percentage sums across correlated lanes are not portfolio returns; there is no exchange executor or automatic settings change."}
  await writeFile(output,JSON.stringify(result,null,2)+"\n")
  console.log(JSON.stringify({event:"complete",ordersSubmitted:0,variants:variants.map(v=>({name:v.name,...v.heldout}))}))
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Study failed");process.exitCode=1})
