import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/docker-smoke.mjs [image=cts-c:verified]\nRequires Docker. Creates and removes only its own container and named volume; submits no exchange orders.')
  process.exit(0)
}
const run = promisify(execFile), image = process.argv[2] || 'cts-c:verified'
const name = `ctsc-smoke-${randomBytes(8).toString('hex')}`, volume = `${name}-data`
const password = randomBytes(32).toString('hex')
let origin, volumeCreated = false
async function docker(args) {
  const { stdout } = await run('docker', args, { env: { ...process.env, CTS_ADMIN_PASSWORD: password }, timeout: 60_000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
function request(path, options = {}) {
  return fetch(origin + path, { ...options, signal: AbortSignal.timeout(5_000) })
}
async function start() {
  await docker(['run', '--detach', '--init', '--name', name, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--publish', '127.0.0.1::3001', '--mount', `type=volume,source=${volume},target=/app/data`,
    '--env', 'CTS_ADMIN_PASSWORD', '--env', 'CTS_DATA_DIR=/app/data', '--env', 'CTS_COOKIE_SECURE=false',
    '--env', 'CTS_TRUSTED_ORIGINS=', '--env', 'BINGX_X02_KEY=', '--env', 'BINGX_X02_SECRET=',
    '--env', 'BINGX_X02_API_KEY=', '--env', 'BINGX_X02_API_SECRET=', image])
  const binding = await docker(['port', name, '3001/tcp'])
  assert.match(binding, /^127\.0\.0\.1:\d+$/)
  origin = `http://${binding}`
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    try { const health = await request('/api/health'); if (health.ok && (await health.json()).ready === true) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Container did not become healthy within 40 seconds')
}
async function stop() {
  await docker(['stop', '--time', '15', name])
  await docker(['rm', name])
}
function action(cookie, body) {
  return request('/api/terminal', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
try {
  await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  await docker(['volume', 'create', volume]); volumeCreated = true
  await start()
  assert.equal((await request('/api/terminal')).status, 401)
  const login = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const response = await request('/api/terminal', { headers: { Cookie: cookie } }); assert.equal(response.status, 200)
  const initial = await response.json()
  assert.equal(initial.readiness.x02Configured, false); assert.equal(initial.equity, null)
  assert.equal(initial.openPositions.length, 0)
  assert.equal((await action(cookie, { action: 'start-x02' })).status, 400)
  assert.equal((await action(cookie, { action: 'save-settings', settings: { mainEvalPosCount: 7, symbolCount: 25 } })).status, 200)
  await stop(); await start()
  const restored = await request('/api/terminal', { headers: { Cookie: cookie } }); assert.equal(restored.status, 200)
  const state = await restored.json()
  assert.equal(state.settings.mainEvalPosCount, '7'); assert.equal(state.settings.symbolCount, '25')
  assert.equal(state.readiness.x02Configured, false)
  assert.equal((await action(cookie, { action: 'save-settings', settings: { symbolCount: 30 } })).status, 200)
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 200)
  await stop(); await start()
  assert.equal((await request('/api/terminal', { headers: { Cookie: cookie } })).status, 401)
  console.log(JSON.stringify({ dockerRuntimePassed: true, persistentVolume: true, durableLogout: true, x02Configured: false, ordersSubmitted: 0 }))
} catch (error) {
  const logs = await docker(['logs', '--tail', '60', name]).catch(() => '')
  if (logs) console.error(logs.replaceAll(password, '[fixture-password]'))
  throw error
} finally {
  await docker(['rm', '--force', name]).catch(() => {})
  if (volumeCreated) await docker(['volume', 'rm', volume]).catch(() => { console.error(`Cleanup required for test volume ${volume}`) })
}
