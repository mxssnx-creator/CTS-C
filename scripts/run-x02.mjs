/** Explicitly start the long-lived VST runtime and retain a local status record. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, chmodSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { loadEnvFile } from 'node:process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function createRequester(origin, password, fetcher = fetch) {
  let cookie = ''
  async function request(path, body, retried = false) {
    const response = await fetcher(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 401 && cookie && path !== '/api/auth/login' && !retried) {
      await response.body?.cancel()
      await authenticate()
      return request(path, body, true)
    }
    // Never copy an arbitrary response body into logs: it may contain account data.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${path}: HTTP ${response.status}`) }
    const result = await response.json()
    return { response, result }
  }
  async function authenticate() {
    const login = await request('/api/auth/login', { password })
    const nextCookie = login.response.headers.get('set-cookie')?.split(';')[0]
    if (!nextCookie || !/^cts_session=[a-f0-9]{64}$/.test(nextCookie)) throw new Error('Login returned no valid session cookie')
    cookie = nextCookie
  }
  return { request, authenticate }
}

export function childIsRunning(child) { return child.exitCode === null && child.signalCode === null }
export function childCompletion(child) {
  // Install listeners immediately after spawn; signal exits also leave exitCode null.
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', error => resolve({ error }))
  })
}
export async function stopChild(child, completion) {
  if (childIsRunning(child)) child.kill('SIGTERM')
  await completion
}
export async function assertPortAvailable(port) {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
  })
}
export function writeObservation(directory, status) {
  const target = join(directory, 'x02-runtime-observation.json')
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(status, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
export async function observeRuntime({ request, isRunning, isStopping, publish, sleep, warn }) {
  while (!isStopping()) {
    if (!isRunning()) throw new Error('Server stopped unexpectedly; inspect runtime-server.log')
    try {
      const { result } = await request('/api/terminal')
      if (!isStopping()) publish(result)
    } catch {
      if (isStopping()) break
      if (!isRunning()) throw new Error('Server stopped unexpectedly; inspect runtime-server.log')
      // Observation/auth/network failures must not terminate the trading server.
      warn('Status observation unavailable; retrying in 5 seconds')
    }
    if (!isStopping()) await sleep(5000)
  }
}

export async function runX02() {
  if (!process.argv.includes('--execute')) throw new Error('Pass --execute to start the authorized x02 VST runtime')
  for (const file of ['.env.local', '.env']) if (existsSync(file)) loadEnvFile(file)
  if (!process.env.CTS_ADMIN_PASSWORD || process.env.CTS_ADMIN_PASSWORD.length < 12) throw new Error('CTS_ADMIN_PASSWORD of at least 12 characters is required')
  const dataDir = resolve(process.env.CTS_DATA_DIR || '.data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700)
  const port = Number(process.env.PORT || '3001')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535')
  // Refuse an existing listener before sending either credentials or start actions.
  await assertPortAvailable(port)
  const origin = `http://127.0.0.1:${port}`
  const logPath = join(dataDir, 'runtime-server.log'), log = openSync(logPath, 'a', 0o600)
  chmodSync(logPath, 0o600)
  const child = spawn(process.execPath, ['scripts/start-server.mjs'], { env: { ...process.env, CTS_DATA_DIR: dataDir, CTS_HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', log, log] })
  const completion = childCompletion(child)
  closeSync(log)
  let stopping = false, lastReported = ''
  const stop = () => { stopping = true; if (childIsRunning(child)) child.kill('SIGTERM') }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
  const { request, authenticate } = createRequester(origin, process.env.CTS_ADMIN_PASSWORD)
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  try {
    for (let i = 0; i < 100; i++) {
      if (!childIsRunning(child)) throw new Error('Server exited; inspect runtime-server.log')
      if (stopping) return
      try {
        const health = await request('/api/health')
        if (health.result.ready !== true || health.result.application !== 'CTS-C') throw new Error('Unexpected health response')
        break
      } catch { if (i === 99) throw new Error('Server did not become ready'); await sleep(200) }
    }
    if (stopping || !childIsRunning(child)) return
    await authenticate()
    if (stopping || !childIsRunning(child)) return
    await request('/api/terminal', { action: 'save-settings', settings: { symbolCount: 100, historyCandles: 1440, volumeFactor: .01 } })
    if (stopping || !childIsRunning(child)) return
    await request('/api/terminal', { action: 'start-x02' })
    await observeRuntime({ request, isRunning: () => childIsRunning(child), isStopping: () => stopping, sleep, warn: message => console.error(message), publish: s => {
      const status = { checkedAt: new Date().toISOString(), environment: 'BingX VST', runtime: s.readiness, connection: s.connections[0], symbols: s.engine.symbolCount, configurations: s.engine.catalogCount, processedCandles: s.engine.processedCandles, stages: s.stages, execution: s.execution.summary }
      writeObservation(dataDir, status)
      const key = JSON.stringify([s.readiness.status, Math.floor(s.engine.processedCandles / 10000), s.execution.summary.ownedLots])
      if (key !== lastReported) {
        console.log(JSON.stringify({ at: status.checkedAt, status: s.readiness.status, symbols: status.symbols, configurations: status.configurations, processedCandles: status.processedCandles, ownedExchangeLots: s.execution.summary.ownedLots }))
        lastReported = key
      }
    } })
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop)
    await stopChild(child, completion)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runX02().catch(error => { console.error(error.message); process.exitCode = 1 })
}
