/** Explicitly start the x01 MAINNET runtime (real money). Entries still pass the engine's qualification gates. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, chmodSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STARTUP_REQUEST_TIMEOUT, createRequester, waitForReady, saveInitialSettings, childIsRunning, childCompletion, stopChild, assertPortAvailable, observeRuntime } from './run-x02.mjs'

const CONNECTION = 'bingx-x01'
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : Number(process.argv[i + 1]) }
const word = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
function writeObservation(directory, status) {
  const target = join(directory, 'x01-runtime-observation.json'), temporary = `${target}.${process.pid}.tmp`
  try { writeFileSync(temporary, JSON.stringify(status, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temporary, target) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

export async function runX01() {
  if (!process.argv.includes('--execute') || !process.argv.includes('--real-money')) throw new Error('Pass --execute --real-money to start the x01 MAINNET runtime with real funds')
  for (const file of ['.env.local', '.env']) if (existsSync(file)) loadEnvFile(file)
  if (!process.env.CTS_ADMIN_PASSWORD || process.env.CTS_ADMIN_PASSWORD.length < 12) throw new Error('CTS_ADMIN_PASSWORD of at least 12 characters is required')
  if (!(process.env.BINGX_X01_KEY && process.env.BINGX_X01_SECRET)) throw new Error('BINGX_X01_KEY and BINGX_X01_SECRET are required; x01 never reuses other credentials')
  const symbolCount = flag('--symbols', 60), historyCandles = flag('--history-candles', 1440), maxOrderNotional = flag('--max-order-notional', 2)
  if (!Number.isInteger(symbolCount) || symbolCount < 1 || symbolCount > 500) throw new Error('--symbols must be 1..500')
  if (!Number.isInteger(historyCandles) || historyCandles < 100 || historyCandles > 4320) throw new Error('--history-candles must be 100..4320')
  if (!(maxOrderNotional > 0 && maxOrderNotional <= 10)) throw new Error('--max-order-notional must be above 0 and at most 10 USDT')
  // Relate stays off unless asked: --relate loss|wins [--relate-steps N] [--relate-ratio X] [--relate-max-multiplier M]. The server validates the values.
  const relateMode = word('--relate')
  if (relateMode !== undefined && relateMode !== 'loss' && relateMode !== 'wins') throw new Error('--relate must be loss or wins')
  const relate = relateMode === undefined ? {} : {
    relateEnabled: true, relateAutoEnabled: true, relateStepMode: relateMode,
    ...(process.argv.includes('--relate-steps') && { relateSteps: flag('--relate-steps') }),
    ...(process.argv.includes('--relate-ratio') && { relateRatio: flag('--relate-ratio') }),
    ...(process.argv.includes('--relate-max-multiplier') && { relateMaxMultiplier: flag('--relate-max-multiplier') }),
  }
  const dataDir = resolve(process.env.CTS_DATA_DIR || '.data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700)
  const port = Number(process.env.PORT || '3001')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535')
  await assertPortAvailable(port)
  const origin = `http://127.0.0.1:${port}`
  const logPath = join(dataDir, 'runtime-server-x01.log'), log = openSync(logPath, 'a', 0o600)
  chmodSync(logPath, 0o600)
  const child = spawn(process.execPath, ['scripts/start-server.mjs'], { env: { ...process.env, CTS_DATA_DIR: dataDir, CTS_HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', log, log] })
  const completion = childCompletion(child)
  closeSync(log)
  let stopping = false, lastReported = ''
  const stop = () => { stopping = true; if (childIsRunning(child)) child.kill('SIGTERM') }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
  const { request: raw, authenticate } = createRequester(origin, process.env.CTS_ADMIN_PASSWORD)
  const request = (path, body, options) => raw(body === undefined && path === '/api/terminal' ? `${path}?connection=${CONNECTION}` : path, body && path === '/api/terminal' ? { ...body, connectionId: CONNECTION } : body, options)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  try {
    const canContinue = () => !stopping && childIsRunning(child)
    await waitForReady({ request: raw, canContinue, sleep })
    if (!canContinue()) return
    await authenticate({ timeoutMs: STARTUP_REQUEST_TIMEOUT })
    if (!canContinue()) return
    // Minimum volume factor and a small per-order cap; every other saved setting is kept.
    await saveInitialSettings(request, { symbolCount, historyCandles, volumeFactor: .01, maxOrderNotional, ...relate }, { sleep, canContinue })
    if (!canContinue()) return
    await request('/api/terminal', { action: 'start-x01' }, { timeoutMs: STARTUP_REQUEST_TIMEOUT })
    await observeRuntime({ request, isRunning: () => childIsRunning(child), isStopping: () => stopping, sleep, warn: m => console.error(m), publish: s => {
      const status = { checkedAt: new Date().toISOString(), environment: 'BingX mainnet', runtime: s.readiness, connection: s.connections.find(c => c.id === CONNECTION), symbols: s.engine.symbolCount, configurations: s.engine.catalogCount, processedCandles: s.engine.processedCandles, stages: s.stages, execution: s.execution.summary }
      writeObservation(dataDir, status)
      const key = JSON.stringify([s.readiness.status, Math.floor(s.engine.processedCandles / 10000), s.execution.summary.ownedLots])
      if (key !== lastReported) { console.log(JSON.stringify({ at: status.checkedAt, status: s.readiness.status, symbols: status.symbols, configurations: status.configurations, processedCandles: status.processedCandles, ownedExchangeLots: s.execution.summary.ownedLots })); lastReported = key }
    } })
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop)
    await stopChild(child, completion)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runX01().catch(error => { console.error(error.message); process.exitCode = 1 })
