/** Read-only reload of a stopped, observed run; no credentials or exchange client. */
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {TradingEngine} from '../core/engine'
import type {EngineState,StrategyConfig} from '../core/types'
import type {TradeBar} from '../core/trade-stream'

const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
let maxFloatDifference=0
function compareMetrics(actual:any,expected:any,path='stages'){
 if(typeof actual==='number'&&typeof expected==='number'&&/(profitFactor|currentProfitFactor|netPnl|fees|enoughSamplesPct)$/.test(path)){
  const delta=Math.abs(actual-expected);maxFloatDifference=Math.max(maxFloatDifference,delta)
  assert.ok(delta<=1e-9+Math.abs(expected)*1e-10,`Reload metric changed at ${path}: ${actual} versus ${expected}`)
 }else if(actual&&expected&&typeof actual==='object'&&typeof expected==='object'){
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),path)
  for(const key of Object.keys(actual))compareMetrics(actual[key],expected[key],`${path}.${key}`)
 }else assert.deepEqual(actual,expected,path)
}
async function main(){
 const directory=resolve(arg('--directory','.data/micro-live-50'))
 const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'))
 const db=new DatabaseSync(join(directory,'runtime.sqlite'),{readOnly:true})
 const control=db.prepare("SELECT data FROM records WHERE key='control'").get() as {data:string}
 assert.equal(JSON.parse(control.data).running,false,'Only a stopped runtime can be audited')
 const row=db.prepare("SELECT data FROM records WHERE key='engine'").get() as {data:string}
 const decoded=JSON.parse(row.data)
 const state:EngineState=decoded.checkpointFormat==='lane-rows-v1'?{...decoded.state,lanes:{}}:decoded
 const configs=new Map<string,StrategyConfig>()
 if(decoded.checkpointFormat==='lane-rows-v1')for(const row of db.prepare('SELECT id,data FROM engine_lanes ORDER BY id').iterate() as Iterable<{id:string;data:string}>){
  const lane=JSON.parse(row.data);assert.equal(lane.id,row.id)
  const key=JSON.stringify(lane.config);lane.config=configs.get(key)??lane.config;configs.set(key,lane.config)
  state.lanes[row.id]=lane
 }
 const cursors={minute:{...state.lastTimestamp},micro:{...state.lastMicroTimestamp}}
 const engine=TradingEngine.fromOwnedCheckpoint(state)
 const before=engine.snapshot({laneLimit:0,positionLimit:0}).stages
 // Row ordering can change floating-point summation by a few nanounits.
 // Counts, identities and gate states remain exact; only monetary/PF sums use tolerance.
 compareMetrics(before,result.stages)
 let duplicateBars=0,duplicateEvents=0
 for(const symbol of engine.settings.symbols){
  assert.equal(engine.lastProcessedAt(symbol),cursors.minute[symbol]??null)
  assert.equal(engine.lastProcessedAt(symbol,10),cursors.micro[symbol]??null)
  const row=db.prepare('SELECT data FROM market_trade_bars WHERE symbol=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1').get(symbol,cursors.micro[symbol]??0) as {data:string}|undefined
  if(!row)continue
  const bar=JSON.parse(row.data) as TradeBar
  duplicateEvents+=engine.processCandles(symbol,[bar],{barSeconds:10,allowExecution:false}).length
  duplicateBars++
 }
 assert.equal(duplicateEvents,0)
 assert.deepEqual(engine.snapshot({laneLimit:0,positionLimit:0}).stages,before,'Duplicate source bars must not add samples or positions')
 const unresolved=(db.prepare("SELECT count(*) AS n FROM intents WHERE status IN ('reserved','unknown')").get() as {n:number}).n
 const journal=(db.prepare('SELECT count(*) AS n FROM intents').get() as {n:number}).n
 db.close()
 const evidence={checkedAt:new Date().toISOString(),passed:true,scope:'Read-only stopped checkpoint reload; no exchange calls. This is not a live crash/restart test with open exchange positions.',symbols:engine.settings.symbols.length,lanes:Object.keys(state.lanes).length,stageMetricsPreserved:true,countsAndGateStatesExact:true,floatTolerance:'1e-9 absolute + 1e-10 relative',maxFloatDifference,cursorsPreserved:true,duplicateBars,duplicateEvents,journalIntents:journal,unresolvedIntents:unresolved,sourceCursorSha256:createHash('sha256').update(JSON.stringify(cursors)).digest('hex'),exchangeWrites:0}
 await writeFile(arg('--output',join(directory,'checkpoint-audit.json')),JSON.stringify(evidence,null,2))
 console.log(JSON.stringify(evidence))
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Checkpoint audit failed');process.exitCode=1})
