import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { waveBars } from '../shared/cts-indications/fixtures'

test('source batches preserve the same independent replay outcomes as a combined Signals run', {timeout:30000},()=>{
 const directory=mkdtempSync(join(tmpdir(),'ctsc-signal-batches-'))
 try {
  const tapes=join(directory,'tapes'),output=join(directory,'batches'),scenarioFile=join(directory,'scenario.json'),combined=join(directory,'combined.json')
  mkdirSync(tapes)
  const bars=waveBars(400).map(row=>({...row,timestamp:row.timestamp+60000}))
  writeFileSync(join(tapes,'BTC-USDT.json'),JSON.stringify(bars))
  const windows={base:{long:[10],short:[4],last:[1]},main:{long:['none'],short:[4],last:[1]},
   real:{long:['none'],short:[4],last:[1]},exec:{long:['none'],short:[4],last:[1]}}
  const scenario={tapeMinutes:400,warmupMinutes:200,fitMinutes:100,groupSources:true,settings:{
   catalog:{strategyIndicationTypes:['Signals'],strategySignalsSources:['sig-ema-cross-s','sig-ema-cross-s-follow'],
    strategyEnabledRanges:['Micro'],strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],
    strategySignalTimeframes:[1],strategyExecWindows:windows,signalsMaxWindowDrawdownPct:0},
   coordinations:{axis:{enabled:false},block:{enabled:false},dca:{enabled:false},relate:{enabled:false}}}}
  writeFileSync(scenarioFile,JSON.stringify(scenario))
  const run=(args:string[])=>{
   const child=spawnSync(process.execPath,['--import','tsx',...args],{cwd:process.cwd(),encoding:'utf8',timeout:25000})
   assert.equal(child.status,0,child.stderr)
  }
  const short=spawnSync(process.execPath,['--import','tsx','scripts/replay-exec-signal-batches.ts',tapes,join(directory,'short'),scenarioFile,'2','1'],{cwd:process.cwd(),encoding:'utf8'})
  assert.notEqual(short.status,0);assert.match(short.stderr,/Requested 2 symbol tapes but found 1/)
  run(['scripts/replay-exec-stages.ts',tapes,combined,'short','signals','1','1',scenarioFile])
  run(['scripts/replay-exec-signal-batches.ts',tapes,output,scenarioFile,'1','1'])
  const one=JSON.parse(readFileSync(combined,'utf8')),index=JSON.parse(readFileSync(join(output,'index.json'),'utf8'))
  assert.equal(index.batches.length,2)
  const parts=index.batches.map((batch:{result:string})=>JSON.parse(readFileSync(join(output,batch.result),'utf8')))
  assert.ok(one.stages.base.fit.closes+one.stages.base.holdout.closes>0)
  for(const section of ['stages','postStages'])for(const stage of Object.keys(one[section]))for(const period of ['fit','holdout'])
   for(const key of ['closes','wins','profit','loss','fees','pnl']){
    const expected=one[section][stage][period][key]
    const actual=parts.reduce((sum:number,part:any)=>sum+part[section][stage][period][key],0)
    assert.ok(Math.abs(actual-expected)<1e-9,`${section}/${stage}/${period}/${key}`)
   }
 } finally {rmSync(directory,{recursive:true,force:true})}
})
