import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cts-standalone-"))
const snapshotPath = join(temporaryDirectory, "redis-snapshot.json")
const runningServers = new Set()

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function freePort(excluded) {
  for (;;) {
    const server = createServer()
    await new Promise((resolveListen, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolveListen)
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    await new Promise((resolveClose) => server.close(resolveClose))
    if (port && port !== excluded) return port
  }
}

function startServer(port, secret) {
  const child = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      JWT_SECRET: secret,
      CRON_SECRET: `${secret}-cron`,
      ADMIN_AUTOLOGIN_ENABLED: "true",
      ALLOW_SELF_REGISTRATION: "false",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  const collect = (chunk) => {
    output = `${output}${chunk}`.slice(-16_000)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  child.getOutput = () => output
  runningServers.add(child)
  child.once("exit", () => runningServers.delete(child))
  return child
}

async function waitUntilReady(port, child) {
  const url = `http://127.0.0.1:${port}/api/health/liveness`
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Standalone server exited early\n${child.getOutput()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error(`Standalone server did not become ready\n${child.getOutput()}`)
}

async function adminIdentity(port) {
  const origin = `http://127.0.0.1:${port}`
  const login = await fetch(`${origin}/api/auth/auto-login`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: "{}",
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie")?.split(";")[0] || ""
  assert.match(cookie, /^cts_auth=/)
  const response = await fetch(`${origin}/api/system/identity`, { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  return (await response.json()).data
}

async function runIntegrationTests(port) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test",
    "__tests__/integration/progression-api.test.ts",
    "__tests__/e2e/progression-flow.test.ts",
  ], {
    cwd: root,
    env: { ...process.env, CTS_TEST_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: "inherit",
  })
  const [code, signal] = await once(child, "exit")
  assert.equal(signal, null)
  assert.equal(code, 0)
}

async function stopServer(child) {
  if (child.exitCode !== null) return child.exitCode
  child.kill("SIGTERM")
  const result = await Promise.race([
    once(child, "exit"),
    delay(15_000).then(() => { throw new Error(`Standalone server ignored SIGTERM\n${child.getOutput()}`) }),
  ])
  const [code, signal] = result
  assert.equal(signal, null)
  assert.equal(code, 0)
}

try {
  const firstPort = await freePort()
  const secondPort = await freePort(firstPort)
  const firstServer = startServer(firstPort, "cts-standalone-validation-secret-one-2026")
  await waitUntilReady(firstPort, firstServer)
  await runIntegrationTests(firstPort)
  const firstIdentity = await adminIdentity(firstPort)
  const rootResponse = await fetch(`http://127.0.0.1:${firstPort}/`)
  assert.equal(rootResponse.status, 200)
  await stopServer(firstServer)

  assert.ok((await stat(snapshotPath)).size > 0)
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  assert.equal(snapshot.v, 1)
  assert.ok(Array.isArray(snapshot.hashes))

  const secondServer = startServer(secondPort, "cts-standalone-validation-secret-two-2026")
  await waitUntilReady(secondPort, secondServer)
  const secondIdentity = await adminIdentity(secondPort)
  const readiness = await fetch(`http://127.0.0.1:${secondPort}/api/health/readiness`)
  assert.equal(readiness.status, 200)
  const readinessBody = await readiness.json()
  assert.equal(readinessBody.ready, true)
  assert.deepEqual(readinessBody.components, {
    redis: true,
    database: true,
    migrations: true,
    persistence: true,
  })

  assert.equal(secondIdentity.siteSessionId, firstIdentity.siteSessionId)
  assert.notEqual(secondIdentity.runtimeInstanceId, firstIdentity.runtimeInstanceId)
  assert.equal(secondIdentity.isNew, false)
  assert.ok(secondIdentity.persistence.lastSuccessfulLoadAt)
  await stopServer(secondServer)

  console.log("Standalone auth, SIGTERM snapshot, restart continuity and readiness passed")
} finally {
  for (const child of runningServers) child.kill("SIGKILL")
  await rm(temporaryDirectory, { recursive: true, force: true })
}
