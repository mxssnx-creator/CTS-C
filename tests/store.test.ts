import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../core/store'
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
