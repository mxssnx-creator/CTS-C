import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../core/store'
import { DEFAULT_ENGINE_SETTINGS } from '../core/engine'
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
