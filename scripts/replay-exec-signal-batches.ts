/** Bound a Signals-only research run by evaluating one independent source per process. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkedSignalsSources } from '../shared/cts-indications/signals-catalog'
import { EXEC_PROFILES } from '../core/exec-profile'

async function main(){
 const [tapesText,outputText,scenarioText,countText='7',workersText='1']=process.argv.slice(2)
 if(!tapesText||!outputText||!scenarioText)throw new Error('Usage: replay-exec-signal-batches <tape directory> <new output directory> <scenario.json> [symbol count] [workers]')
 const count=Number(countText),workers=Number(workersText)
 if(![count,workers].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error('Invalid symbol or worker count')
 const bytes=readFileSync(scenarioText),scenario=JSON.parse(bytes.toString())
 const catalog=scenario?.settings?.catalog
 if(!catalog||!Array.isArray(catalog.strategyIndicationTypes)||catalog.strategyIndicationTypes.length!==1||catalog.strategyIndicationTypes[0]!=='Signals')
  throw new Error('Batched runs require an explicit Signals-only indication selection')
 if(EXEC_PROFILES.some(profile=>catalog[profile.setting]===true))throw new Error('Disable additional Exec profiles for a source-isolated batch')
 const sources=checkedSignalsSources(catalog.strategySignalsSources)
 const directory=resolve(outputText),tapes=resolve(tapesText)
 const available=readdirSync(tapes).filter(file=>/^[A-Z0-9]+-USDT\.json$/.test(file)).length
 if(available<count)throw new Error(`Requested ${count} symbol tapes but found ${available}`)
 mkdirSync(directory,{mode:0o700})
 const index:{source:string;scenario:string;result:string}[]=[]
 const runner=fileURLToPath(new URL('./replay-exec-stages.ts',import.meta.url))
 for(const [n,source] of sources.entries()){
  const tag=String(n+1).padStart(3,'0'),scenarioName=`source-${tag}.scenario.json`,resultName=`source-${tag}.result.json`
  const childScenario=structuredClone(scenario)
  childScenario.settings.catalog.strategySignalsSources=[source]
  writeFileSync(join(directory,scenarioName),JSON.stringify(childScenario,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stderr.write(`Signals batch ${n+1}/${sources.length}: ${source}\n`)
  await new Promise<void>((accept,reject)=>{
   const child=spawn(process.execPath,['--import','tsx',runner,tapes,join(directory,resultName),'short','signals',String(count),String(workers),join(directory,scenarioName)],{stdio:'inherit'})
   child.once('error',reject)
   child.once('exit',(code,signal)=>code===0?accept():reject(new Error(`Signals batch ${source} failed (${signal??code}); completed batches remain in ${directory}`)))
  })
  index.push({source,scenario:scenarioName,result:resultName})
  writeFileSync(join(directory,'index.json'),JSON.stringify({scenarioSha256:createHash('sha256').update(bytes).digest('hex'),symbolCount:count,workers,batches:index},null,2)+'\n',{mode:0o600})
 }
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Signals batching failed');process.exitCode=1})
