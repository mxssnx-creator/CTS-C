import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { POST } from '../app/api/terminal/route'
import { login } from '../core/auth'
import { getRuntime } from '../core/runtime'
import { getStore } from '../core/store'

test('terminal returns retryable 409 only for initial acquisition refused before settings mutate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ctsc-owned-route-'))
  const previousDirectory = process.env.CTS_DATA_DIR, previousPassword = process.env.CTS_ADMIN_PASSWORD, previousFetch = globalThis.fetch
  process.env.CTS_DATA_DIR = directory
  process.env.CTS_ADMIN_PASSWORD = 'isolated-route-password'
  globalThis.fetch = async () => { throw new Error('Network forbidden in route test') }
  try {
    const response = await login(new Request('http://127.0.0.1/api/auth/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1' }, body: JSON.stringify({ password: process.env.CTS_ADMIN_PASSWORD }) }))
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const runtime = getRuntime(), store = getStore(), before = runtime.control.symbolCount
    assert.ok(store.acquireLease('other-running-process'))
    const request = () => new NextRequest('http://127.0.0.1/api/terminal', { method: 'POST', headers: { Origin: 'http://127.0.0.1', Host: '127.0.0.1', Cookie: cookie }, body: JSON.stringify({ action: 'save-settings', settings: { symbolCount: 20 } }) })
    const denied = await POST(request())
    assert.equal(denied.status, 409)
    assert.equal((await denied.json()).code, 'RUNTIME_OWNED')
    assert.equal(runtime.control.symbolCount, before, 'conflict must precede any settings mutation')
    store.releaseLease('other-running-process')
    ;(runtime as any).leaseLost = true
    const lost = await POST(request())
    assert.equal(lost.status, 400)
    assert.equal((await lost.json()).code, undefined, 'lost ownership must require process restart, not retry')
  } finally {
    getRuntime().shutdown(); getStore().close(); globalThis.fetch = previousFetch
    if (previousDirectory === undefined) delete process.env.CTS_DATA_DIR; else process.env.CTS_DATA_DIR = previousDirectory
    if (previousPassword === undefined) delete process.env.CTS_ADMIN_PASSWORD; else process.env.CTS_ADMIN_PASSWORD = previousPassword
    rmSync(directory, { recursive: true, force: true })
  }
})
