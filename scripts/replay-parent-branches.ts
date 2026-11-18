/** Replay a contiguous twelve-symbol minute archive through the normal engine and reconcile exact parent fills. */
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { TradingEngine, DEFAULT_ENGINE_SETTINGS } from "../core/engine"
import { DEFAULT_LOW_RANGE_SOURCES } from "../shared/cts-indications/low-range-catalog"
import type { Candle, ClosedTrade } from "../core/types"

const [feedPath, output, date, mode] = process.argv.slice(2)
if (!date || !["reference","inherited","crossed"].includes(mode)) throw Error("Expected FEED OUTPUT YYYY-MM-DD reference|inherited|crossed")
const bytes = readFileSync(feedPath), feed = JSON.parse(bytes.toString()).candles
const start = Date.parse(date+"T00:00:00Z"), minute = 60000
const entries = Object.entries(feed).filter(([k]) => k.endsWith("|1"))
type Row = {t:number;o:number;h:number;l:number;c:number;v:number}
const prices = Object.fromEntries(entries.map(([id, raw]) => {
  const bars = (raw as Row[]).filter(r => r.t >= start-1440*minute && r.t < start+2880*minute)
  if (bars.length !== 4320 || bars.some((r,i) => r.t !== start+(i-1440)*minute)) throw Error("Incomplete archive for " + id)
  return [id.slice(0,-2),bars.map((r): Candle => ({timestamp:r.t+minute,open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v}))]
}))
const symbols = Object.keys(prices)
if (symbols.length !== 12) throw Error("A complete 12-symbol archive is required")
const catalog = {
  strategyEnabledRanges:["Low-Range","Short"], strategyIndicationTypes:["Low-Range","Trend","Break"],
  strategyLowRangeSources:DEFAULT_LOW_RANGE_SOURCES.slice(0,2),strategyTpSteps:[5,12],
  strategySlRatios:[.4,.8],strategyExitModes:["fixed","trailing","trailing-fixed"],strategySignalTimeframes:[1,5],
  strategyPriceDistancesEnabled:true,strategyStopDistancePcts:[.3,.7],strategyTrailDistancePcts:[.3,.7],
  strategyLastNGrid:{real:[8,12]},makerFeePct:.03,takerFeePct:.05,slippagePctOfFees:10,autoPfEnabled:true,autoPfRatio:.2,holdTimeFactor:2,
  ...(mode === "crossed" ? {strategyStageCoordinations:{main:["normal","block","relate"],real:["normal","block","relate"]}} : {})
}
const engine = new TradingEngine({symbols,stageGateMode:mode === "reference"?"processed-sets":"parent-branches",stageWindowScope:"both",catalog,
  initialEquity:1000,baseNotional:1000,volumeFactor:.01,coordinations:{...DEFAULT_ENGINE_SETTINGS.coordinations,
    block:{...DEFAULT_ENGINE_SETTINGS.coordinations.block,behavior:"rounds",auto:{enabled:true,lastN:60,minSamples:30,minPF:1.1}},
    relate:{...DEFAULT_ENGINE_SETTINGS.coordinations.relate!,enabled:true}}})
const period = (from:number,to:number) => Object.fromEntries(symbols.map(s=>[s,prices[s].slice(from,to)]))
function book(){return {count:0,profit:0,loss:0,stressProfit:0,stressLoss:0,long:0,cash:0,peak:0,drawdown:0}}
type Book = ReturnType<typeof book>
function add(b:Book,t:Readonly<ClosedTrade>){
  b.count++; b.long+=Number(t.direction==="long"); b.profit+=Math.max(0,t.netReturnPct);b.loss+=Math.max(0,-t.netReturnPct)
  const stress=t.netReturnPct-50*t.cost/t.notional
  b.stressProfit+=Math.max(0,stress);b.stressLoss+=Math.max(0,-stress);b.cash+=t.netPnl;b.peak=Math.max(b.peak,b.cash);b.drawdown=Math.max(b.drawdown,b.peak-b.cash)
}
const begin=performance.now()
engine.processMarketCandles(period(0,1440))
const opening=engine.snapshot({laneLimit:0,positionLimit:0}).stages.map(s=>({stage:s.stage,sets:s.currentLanes,passing:s.currentQualified,window:s.validatedWindow}))
const groups=new Map<string,Book>(),matched=book(),live=book(),atClock=new Map<string,Readonly<ClosedTrade>>()
let clock=0, mismatches=0
engine.observeStageCloses(t=>{
  if(t.openedAt<=start)return
  for(const key of [t.stage,t.stage+"/"+t.coordination]){
    let b=groups.get(key);if(!b){b=book();groups.set(key,b)} add(b,t)
  }
  if(t.closedAt!==clock){clock=t.closedAt;atClock.clear()}
  if(t.stage==="real")atClock.set(t.id,t)
  if(t.stage==="live"){
    add(live,t)
    const p=t.parentPositionId&&atClock.get(t.parentPositionId)
    if(!p||p.openedAt!==t.openedAt||p.configId!==t.configId||p.coordination!==t.coordination||p.direction!==t.direction||p.symbol!==t.symbol||
      p.entryPrice!==t.entryPrice||p.exitPrice!==t.exitPrice||p.quantity!==t.quantity||p.netPnl!==t.netPnl||p.cost!==t.cost||p.reason!==t.reason||
      JSON.stringify(p.fills)!==JSON.stringify(t.fills)){mismatches++;return}
    add(matched,p)
  }
})
engine.processMarketCandles(period(1440,4320))
if(engine.pendingIntents().length)throw Error("Offline run emitted venue intents")
const metrics=(b:Book)=>({...b,pf:b.loss?b.profit/b.loss:null,stressedPF:b.stressLoss?b.stressProfit/b.stressLoss:null})
const report={date,mode,symbols,sha256:createHash("sha256").update(bytes).digest("hex"),historyHours:24,tradeHours:48,settings:engine.settings,opening,
  final:engine.snapshot({laneLimit:0,positionLimit:0}).stages.map(s=>({stage:s.stage,lanes:s.currentLanes,qualified:s.currentQualified})),
  groups:Object.fromEntries([...groups].map(([key,v])=>[key,metrics(v)])),matchedReal:metrics(matched),live:metrics(live),mismatches,
  elapsedSeconds:(performance.now()-begin)/1000,maximumRssMiB:process.resourceUsage().maxRSS/1024}
writeFileSync(output,JSON.stringify(report,null,2))
console.log(JSON.stringify({date,mode,closes:live.count,pf:report.live.pf,mismatches,seconds:report.elapsedSeconds}))
if(mismatches) process.exitCode=1
