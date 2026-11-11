import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../core/store'
import { DEFAULT_ENGINE_SETTINGS } from '../core/engine'
import {Worker} from 'node:worker_threads'
import {once} from 'node:events'

test('checkpoint metadata and lanes come from one SQLite snapshot while another connection commits',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ctsc-consistent-read-')),filename=join(directory,'state.sqlite'),store=new StateStore(filename),shared=new SharedArrayBuffer(8),flags=new Int32Array(shared)
 const meta=(generation:number)=>JSON.stringify({checkpointFormat:'lane-rows-v1',state:{generation}}),lane=(generation:number)=>JSON.stringify({id:'lane',generation,config:{id:'config'}})
 store.database.prepare("INSERT INTO records VALUES('engine',?,0)").run(meta(0));store.database.prepare('INSERT INTO engine_lanes VALUES(?,?)').run('lane',lane(0))
 const worker=new Worker(`const {DatabaseSync}=require('node:sqlite'),{workerData,parentPort}=require('node:worker_threads');const db=new DatabaseSync(workerData.filename),flags=new Int32Array(workerData.shared);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');const m=db.prepare("UPDATE records SET data=? WHERE key='engine'"),l=db.prepare("UPDATE engine_lanes SET data=? WHERE id='lane'");parentPort.postMessage('ready');Atomics.wait(flags,0,0);for(let generation=1;generation<=2000&&!Atomics.load(flags,1);generation++){db.exec('BEGIN IMMEDIATE');m.run(JSON.stringify({checkpointFormat:'lane-rows-v1',state:{generation}}));l.run(JSON.stringify({id:'lane',generation,config:{id:'config'}}));db.exec('COMMIT');}db.close();`,{eval:true,execArgv:[],workerData:{filename,shared}})
 try{
  await once(worker,'message');Atomics.store(flags,0,1);Atomics.notify(flags,0)
  for(let i=0;i<1000;i++){const state=store.loadEngineState() as any;assert.equal(state.generation,state.lanes.lane.generation,'a concurrent commit must not mix generations')}
 }finally{Atomics.store(flags,1,1);await worker.terminate();store.close();rmSync(directory,{recursive:true,force:true})}
})
test('small settings snapshot is atomic with the engine checkpoint and legacy settings need no JS ledger parse',()=>{
  const store=new StateStore(':memory:')
  try{
    store.saveEngineJSON(JSON.stringify({version:1,settings:DEFAULT_ENGINE_SETTINGS}),[],DEFAULT_ENGINE_SETTINGS)
    assert.deepEqual(store.engineSettings(),DEFAULT_ENGINE_SETTINGS)
    store.database.prepare("DELETE FROM records WHERE key='engine-settings'").run()
    const getRaw=store.getRaw.bind(store)
    store.getRaw=key=>{assert.notEqual(key,'engine','full ledger must not be fetched into JavaScript');return getRaw(key)}
    assert.deepEqual(store.engineSettings(),DEFAULT_ENGINE_SETTINGS)
  }finally{store.close()}
})
test('durable intent survives restart and can never be claimed twice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ctsc-store-'))
  try {
    const filename = join(directory, 'state.sqlite')
    const first = new StateStore(filename)
    assert.equal(first.claimIntent('id-one', {symbol:'BTC-USDT'}), true)
    assert.equal(first.claimIntent('id-one', {symbol:'BTC-USDT'}), false)
    first.createSession('hash',Date.now()+10_000)
    first.saveEngine({version:1},[{type:'saved'}])
    first.close()
    const second = new StateStore(filename)
    assert.equal(second.claimIntent('id-one', {}), false)
    assert.equal(second.unresolvedIntents().length, 1)
    assert.equal(second.hasSession('hash'), true)
    second.deleteSession('hash')
    second.close()
    const third = new StateStore(filename)
    assert.equal(third.hasSession('hash'), false)
    assert.equal(third.events().length, 1)
    assert.deepEqual(third.get('engine'), {version:1})
    assert.equal(third.getRaw('engine'), '{"version":1}')
    assert.equal(third.getRaw('missing'), null)
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    third.close()
  } finally { rmSync(directory, {recursive:true, force:true}) }
})
