/** Isolated-process benchmark. Replicated symbols are a load fixture, not a trading result. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const option=(key:string,fallback?:string)=>{const i=process.argv.indexOf(key);if(i<0){if(fallback!==undefined)return fallback;throw Error(`Provide ${key}`)}if(!process.argv[i+1])throw Error(`Provide ${key}`);return process.argv[i+1]}
async function main(){
 const module=resolve(option('--engine','core/engine.ts')),input=resolve(option('--candles')),output=resolve(option('--output')),count=Number(option('--symbols','6')),bars=Number(option('--bars','500'))
 if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(bars)||bars<100||bars>1440)throw Error('Invalid benchmark dimensions')
 const {TradingEngine}=await import(pathToFileURL(module).href),raw=JSON.parse(await readFile(input,'utf8')),candles=raw.slice(-bars).map((c:any)=>({timestamp:(c.time+60)*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume})),symbols=Array.from({length:count},(_,i)=>`BENCH${i}-USDT`)
 if(candles.length!==bars)throw Error('Insufficient fixture')
 global.gc?.();const before=process.memoryUsage(),engine=new TradingEngine({symbols,catalog:{makerFeePct:.02,takerFeePct:.05,slippagePctOfFees:10,strategyTpSteps:[3,5,8,12,18,24,30],strategySlRatios:[.6,1,1.4],strategyIndicationTypes:['MA_Cross','RSI_Band','MACD_Signal','Bollinger_Bounce','Trend','Trend_Fade','Break','Break_Reversal']}})
 const slices:number[]=[],start=performance.now()
 for(const symbol of symbols)for(let i=0;i<bars;i+=8){const t=performance.now();engine.processCandles(symbol,candles.slice(i,i+8),{eventLimit:0});slices.push(performance.now()-t)}
 const engineMs=performance.now()-start,serializeStart=performance.now(),state=JSON.parse(engine.serializeState());delete state.startedAt;delete state.settings.stageGateMode
 const serialized=JSON.stringify(state),serializeMs=performance.now()-serializeStart,after=process.memoryUsage(),snapshot=engine.snapshot({laneLimit:0,positionLimit:0});slices.sort((a,b)=>a-b)
 const result={kind:'replicated-observed-candles-engine-load-fixture',generatedAt:new Date().toISOString(),symbols:count,barsPerSymbol:bars,configurations:snapshot.catalogCount,processedCandles:snapshot.processedCandles,engineMs,serializeMs,eightBarSliceMs:{p50:slices[Math.floor(slices.length*.5)],p95:slices[Math.floor(slices.length*.95)],max:slices.at(-1)},heapBeforeBytes:before.heapUsed,heapAfterBytes:after.heapUsed,rssAfterBytes:after.rss,processMaxRssKiB:process.resourceUsage().maxRSS,checkpointBytes:Buffer.byteLength(serialized),outcomeSha256:createHash('sha256').update(serialized).digest('hex'),stages:snapshot.stages,ordersSubmitted:0,methodology:'One observed BTC candle series is replicated under separate synthetic symbol IDs to measure engine load. All 504 configurations and four coordinations run; eight-bar slices retain zero audit events but calculate all positions, samples and metrics. Separate processes permit fair peak-RSS comparison. This does not measure venue, HTTP, UI, serialization overlap or production portfolio returns.'}
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,stages:undefined}))
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Benchmark failed');process.exitCode=1})
