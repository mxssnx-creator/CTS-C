import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BingxMainnetClient,BingxVstClient,BINGX_MAINNET_HOST,BINGX_VST_HOST,connectionCredentials} from '../core/bingx'
import {TerminalRuntime} from '../core/runtime'
import {StateStore} from '../core/store'
import {validateConfiguration,DEFAULTS} from '../core/settings-schema'

test('dedicated credentials and fixed hosts cannot leak between x01 and x02',async()=>{
 const credentials={BINGX_X01_KEY:'main-key',BINGX_X01_SECRET:'main-secret',BINGX_X02_KEY:'demo-key',BINGX_X02_SECRET:'demo-secret'}
 assert.equal(connectionCredentials('bingx-x01',credentials)!.apiKey,'main-key');assert.equal(connectionCredentials('bingx-x02',credentials)!.apiKey,'demo-key')
 assert.equal(connectionCredentials('bingx-x01',{BINGX_X02_KEY:'demo',BINGX_X02_SECRET:'secret',BINGX_API_KEY:'generic',BINGX_API_SECRET:'secret'}),null)
 for(const [Client,host,key] of [[BingxMainnetClient,BINGX_MAINNET_HOST,'main-key'],[BingxVstClient,BINGX_VST_HOST,'demo-key']] as const){
  const client=new Client({apiKey:key,apiSecret:'secret'},{minRequestIntervalMs:0,fetch:async(input,options)=>{
   const url=new URL(String(input));assert.equal(url.origin,host)
   if(url.pathname.endsWith('/server/time'))return Response.json({code:0,data:{serverTime:Date.now()}})
   assert.equal(new Headers(options?.headers).get('X-BX-APIKEY'),key)
   return Response.json({code:0,data:[{asset:'VST',balance:1,equity:1,availableMargin:1,unrealizedProfit:0},{asset:'USDT',balance:2,equity:2,availableMargin:2,unrealizedProfit:0}]})
  }})
  assert.equal((await client.balance()).asset,host===BINGX_MAINNET_HOST?'USDT':'VST')
 }
})

test('settings are strict and independent across account state stores and restarts',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ctsc-account-settings-'))
 const demoStore=new StateStore(join(directory,'x02.sqlite')),mainStore=new StateStore(join(directory,'x01.sqlite'))
 const demo=new TerminalRuntime('bingx-x02',demoStore),main=new TerminalRuntime('bingx-x01',mainStore)
 try{
  main.saveFlatSettings({symbolCount:35,axisVolumeRatio:2,blockVolumeFactor:.3,strategyTpFactor:1.2,strategySlFactor:.8,strategyTrailRatio:.5,holdTimeFactor:2,maxOrderNotional:10})
  assert.equal(demo.engine.settings.volumeRatios!.axis,1);assert.equal(main.engine.settings.volumeRatios!.axis,2)
  assert.equal(demo.control.symbolCount,100);assert.equal(main.control.symbolCount,35)
  assert.equal(main.control.running,false);assert.equal(demo.control.running,false)
  const before=main.engine.serializeState()
  for(const settings of [{axisVolumeRatio:'3'},{volumeFactor:true},{apiSecret:'forbidden'},{strategyTpFactor:10,strategySlFactor:10}])assert.throws(()=>main.saveFlatSettings(settings))
  assert.equal(main.engine.serializeState(),before)
  assert.equal(main.snapshot().execution.lots.length,0);assert.equal(demo.snapshot().execution.lots.length,0)
  main.shutdown()
  const restarted=new TerminalRuntime('bingx-x01',mainStore)
  assert.equal(restarted.snapshot().settings.strategyTpFactor,'1.2');assert.equal(restarted.snapshot().settings.axisVolumeRatio,'2');assert.equal(restarted.control.running,false)
  restarted.shutdown()
  assert.throws(()=>new TerminalRuntime('bingx-x02',mainStore),/another connection/)
  assert.throws(()=>validateConfiguration({...DEFAULTS,axisPrevEnabled:true,axisPrevious:200,axisLast:100}),/250/)
 }finally{demo.shutdown();main.shutdown();demoStore.close();mainStore.close();rmSync(directory,{recursive:true,force:true})}
})
