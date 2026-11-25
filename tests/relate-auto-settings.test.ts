import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {TerminalRuntime} from '../core/runtime'
import {StateStore} from '../core/store'
import {DEFAULTS,validateConfiguration} from '../core/settings-schema'

test('Relate Auto settings save, reject invalid input without changing state, and survive a restart',()=>{
 const store=new StateStore(':memory:'),runtime=new TerminalRuntime('bingx-x02',store)
 try{
  assert.equal(runtime.engine.settings.coordinations.relate!.auto,undefined,'Relate Auto stays off until enabled')
  runtime.saveFlatSettings({relateEnabled:true,relateAutoEnabled:true,relateAutoMinSamples:5,relateAutoLastN:20,relateAutoMinPF:1.2,relateAutoConfidence:1.5,relateAutoInherit:false})
  assert.deepEqual(runtime.engine.settings.coordinations.relate!.auto,{enabled:true,lastN:20,minSamples:5,minPF:1.2,confidence:1.5,inherit:false})
  const flat=runtime.snapshot().settings
  assert.equal(flat.relateAutoEnabled,'true');assert.equal(flat.relateAutoMinSamples,'5');assert.equal(flat.relateAutoInherit,'false');assert.equal(flat.relateAutoConfidence,'1.5')
  const before=runtime.engine.serializeState()
  for(const bad of [{relateAutoMinSamples:25},{relateAutoConfidence:5},{relateAutoLastN:2},{relateAutoMinPF:1},{relateAutoEnabled:'yes'},{relateAutoInherit:1}])assert.throws(()=>runtime.saveFlatSettings(bad))
  assert.equal(runtime.engine.serializeState(),before,'a rejected save changes nothing')
  runtime.shutdown()
  const restarted=new TerminalRuntime('bingx-x02',store)
  assert.deepEqual(restarted.engine.settings.coordinations.relate!.auto,{enabled:true,lastN:20,minSamples:5,minPF:1.2,confidence:1.5,inherit:false})
  restarted.shutdown()
 }finally{runtime.shutdown();store.close()}
})

test('the negatives and Relate Auto preset is valid, applies to a runtime and keeps every stage window polarity',()=>{
 const preset=JSON.parse(readFileSync(new URL('../research-data/exec-negatives-relate-auto-preset.json',import.meta.url),'utf8'))
 const checked=validateConfiguration({...DEFAULTS,...preset})
 for(const stage of ['base','main','real','exec'] as const){
  const windows=(checked.strategyExecWindows as any)[stage]
  assert.deepEqual([...windows.shortOutcomes].sort(),['negative','positive'],`${stage} Short outcomes`)
  assert.deepEqual([...windows.lastOutcomes].sort(),['negative','positive'],`${stage} Last outcomes`)
 }
 const store=new StateStore(':memory:'),runtime=new TerminalRuntime('bingx-x02',store)
 try{
  runtime.saveFlatSettings(preset)
  const windows=runtime.engine.settings.catalog.strategyExecWindows as any
  assert.deepEqual(windows.exec.shortOutcomes,['positive','negative']);assert.deepEqual(windows.base.lastOutcomes,['positive','negative'])
  assert.equal(runtime.engine.settings.coordinations.relate!.enabled,true);assert.equal(runtime.engine.settings.coordinations.relate!.auto!.enabled,true)
  assert.ok(runtime.engine.snapshot({laneLimit:0,positionLimit:0}).catalogCount>0)
 }finally{runtime.shutdown();store.close()}
})
