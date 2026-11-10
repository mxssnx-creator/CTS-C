import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertPortAvailable, childCompletion, childIsRunning, createRequester, observeRuntime, stopChild, writeObservation } from '../scripts/run-x02.mjs'

const token = 'a'.repeat(64), replacement = 'b'.repeat(64)
function login(cookie = token) { return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': `cts_session=${cookie}; Path=/; HttpOnly` } }) }

test('runner refreshes one expired session and retries only the denied request', async () => {
  const calls: { path: string; cookie: string; method: string; redirect: string }[] = []
  let logins = 0
  const client = createRequester('http://127.0.0.1:43210', 'test-password-only', async (url, options) => {
    const path = new URL(String(url)).pathname, cookie = new Headers(options?.headers).get('cookie') || ''
    calls.push({ path, cookie, method: options?.method || 'GET', redirect: options?.redirect || '' })
    if (path === '/api/auth/login') return login(++logins === 1 ? token : replacement)
    return cookie === `cts_session=${token}` ? Response.json({ error: 'expired' }, { status: 401 }) : Response.json({ ready: true })
  })
  await client.authenticate()
  const { result } = await client.request('/api/terminal')
  assert.equal(result.ready, true)
  assert.equal(logins, 2)
  assert.deepEqual(calls.map(call => call.path), ['/api/auth/login', '/api/terminal', '/api/auth/login', '/api/terminal'])
  assert.equal(calls[3].cookie, `cts_session=${replacement}`)
  assert.ok(calls.every(call => call.redirect === 'error'), 'credentials must not follow HTTP redirects')
})

test('runner limits an unsuccessful refresh and excludes response secrets from errors', async () => {
  let logins = 0, reads = 0
  const client = createRequester('http://127.0.0.1:43210', 'test-password-only', async url => {
    if (String(url).endsWith('/api/auth/login')) { logins++; return login() }
    reads++
    return Response.json({ error: 'sensitive-account-value' }, { status: 401 })
  })
  await client.authenticate()
  await assert.rejects(client.request('/api/terminal'), error => error instanceof Error && error.message === '/api/terminal: HTTP 401')
  assert.equal(logins, 2); assert.equal(reads, 2)
})

test('runner rejects missing or malformed login cookies', async () => {
  for (const cookie of ['', 'unexpected=secret', 'cts_session=short']) {
    const client = createRequester('http://127.0.0.1:43210', 'test-password-only', async () => Response.json({}, { headers: { 'Set-Cookie': cookie } }))
    await assert.rejects(client.authenticate(), /no valid session cookie/)
  }
})

test('temporary observation failures recover without stopping the server', async () => {
  let reads = 0, stopping = false, published = 0, warnings = 0
  await observeRuntime({
    request: async () => { if (++reads === 1) throw new Error('Temporary transport error'); return { result: { ready: true } } },
    isRunning: () => true, isStopping: () => stopping,
    publish: (result: { ready: boolean }) => { assert.equal(result.ready, true); published++; stopping = true },
    sleep: async () => {}, warn: () => { warnings++ },
  })
  assert.equal(reads, 2); assert.equal(published, 1); assert.equal(warnings, 1)
})

test('observation stops when the owned server exits instead of retrying forever', async () => {
  await assert.rejects(observeRuntime({ request: async () => { throw new Error('Must not request') }, isRunning: () => false,
    isStopping: () => false, publish: () => {}, sleep: async () => {}, warn: () => {}, }), /Server stopped unexpectedly/)
})

test('cleanup handles an already observed signal exit without waiting for another event', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, kill: () => { throw new Error('Dead process must not be signaled') } })
  const completed = childCompletion(child)
  child.signalCode = 'SIGTERM'
  child.emit('exit', null, 'SIGTERM')
  assert.equal(childIsRunning(child), false)
  await stopChild(child, completed)
  assert.deepEqual(await completed, { code: null, signal: 'SIGTERM' })
})

test('observation atomically replaces a broad-permission file with private valid JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ctsc-observation-'))
  try {
    const target = join(directory, 'x02-runtime-observation.json')
    writeFileSync(target, 'old', { mode: 0o644 })
    writeObservation(directory, { processedCandles: 42 })
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { processedCandles: 42 })
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(directory), ['x02-runtime-observation.json'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runner refuses a port already occupied by another local process', async () => {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  try { await assert.rejects(assertPortAvailable(address.port), { code: 'EADDRINUSE' }) }
  finally { await new Promise<void>(resolve => listener.close(() => resolve())) }
})
