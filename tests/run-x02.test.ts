import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertPortAvailable, childCompletion, childIsRunning, createRequester, observeRuntime, stopChild, writeObservation, RunnerRequestError, saveInitialSettings, waitForReady, STARTUP_REQUEST_TIMEOUT } from '../scripts/run-x02.mjs'

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
  await assert.rejects(client.request('/api/terminal'), error => error instanceof Error && error.message === 'GET /api/terminal: HTTP 401')
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


test('startup requests allow 120 seconds and preserve that timeout through session refresh', async (context) => {
  const timeouts: number[] = []
  const original = AbortSignal.timeout
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { timeouts.push(milliseconds); return original(milliseconds) })
  let reads = 0
  const client = createRequester('http://127.0.0.1:43210', 'test-password-only', async url => {
    if (String(url).endsWith('/api/auth/login')) return login()
    return ++reads === 1 ? Response.json({}, { status: 401 }) : Response.json({ ready: true })
  })
  await client.authenticate({ timeoutMs: STARTUP_REQUEST_TIMEOUT })
  await client.request('/api/terminal', { action: 'start-x02' }, { timeoutMs: STARTUP_REQUEST_TIMEOUT })
  assert.deepEqual(timeouts, [120_000, 120_000, 120_000, 120_000])
  await client.request('/api/terminal')
  assert.equal(timeouts.at(-1), 30_000, 'observations retain the shorter timeout')
})

test('readiness tolerates a restore lasting longer than 30 seconds but remains bounded', async () => {
  let clock = 0, attempts = 0
  const timeouts: number[] = []
  await waitForReady({ now: () => clock, canContinue: () => true, sleep: async (milliseconds: number) => { clock += milliseconds },
    request: async (_path: string, _body: unknown, options: { timeoutMs: number }) => {
      timeouts.push(options.timeoutMs)
      if (++attempts === 1) { clock += 31_000; throw new Error('Restoring persisted engine') }
      return { result: { ready: true, application: 'CTS-C' } }
    },
  })
  assert.equal(attempts, 2); assert.ok(clock > 30_000)
  assert.deepEqual(timeouts, [120_000, 88_800])
  clock = 0; attempts = 0
  await assert.rejects(waitForReady({ now: () => clock, canContinue: () => true, sleep: async (milliseconds: number) => { clock += milliseconds },
    request: async () => { attempts++; clock += 60_000; throw new Error('Unavailable') },
  }), /within 120 seconds/)
  assert.equal(attempts, 2)
})

test('initial settings retry only the explicit pre-mutation ownership refusal', async () => {
  let clock = 0, attempts = 0
  const timeouts: number[] = []
  const result = await saveInitialSettings(async (_path: string, body: { action: string }, options: { timeoutMs: number }) => {
    assert.equal(body.action, 'save-settings'); timeouts.push(options.timeoutMs)
    if (++attempts < 3) throw new RunnerRequestError('POST /api/terminal [save-settings]', 409, 'RUNTIME_OWNED')
    return { result: { success: true } }
  }, { symbolCount: 100 }, { now: () => clock, sleep: async (milliseconds: number) => { clock += milliseconds } })
  assert.equal(result.result.success, true); assert.equal(attempts, 3)
  assert.deepEqual(timeouts, [120_000, 59_000, 58_000])
})

test('ownership waiting stops after 60 seconds and never retries an ambiguous POST failure', async () => {
  let clock = 0, attempts = 0
  await assert.rejects(saveInitialSettings(async () => { attempts++; throw new RunnerRequestError('save-settings', 409, 'RUNTIME_OWNED') }, {},
    { now: () => clock, sleep: async (milliseconds: number) => { clock += milliseconds } }), /ownership unavailable after 60 seconds/)
  assert.equal(clock, 60_000); assert.equal(attempts, 60)
  for (const error of [new RunnerRequestError('save-settings', 400, 'RUNTIME_OWNED'), new RunnerRequestError('save-settings', 409, undefined),
    new RunnerRequestError('save-settings', 500, 'RUNTIME_OWNED'), new Error('timeout: unknown action outcome')]) {
    let calls = 0
    await assert.rejects(saveInitialSettings(async () => { calls++; throw error }, {}, { sleep: async () => {} }), value => value === error)
    assert.equal(calls, 1)
  }
})

test('request failures include the action and only an allowlisted conflict code', async () => {
  const client = createRequester('http://127.0.0.1:43210', 'test-password-only', async () => Response.json({ code: 'RUNTIME_OWNED', error: 'private account details' }, { status: 409 }))
  await assert.rejects(client.request('/api/terminal', { action: 'save-settings' }), error => error instanceof RunnerRequestError
    && error.code === 'RUNTIME_OWNED' && error.message === 'POST /api/terminal [save-settings]: HTTP 409 (RUNTIME_OWNED)')
  const timeout = createRequester('http://127.0.0.1:43210', 'test-password-only', async () => { throw new DOMException('private transport details', 'TimeoutError') })
  await assert.rejects(timeout.request('/api/terminal', { action: 'start-x02' }, { timeoutMs: STARTUP_REQUEST_TIMEOUT }),
    error => error instanceof Error && error.message === 'POST /api/terminal [start-x02]: request timed out after 120000ms')
})
