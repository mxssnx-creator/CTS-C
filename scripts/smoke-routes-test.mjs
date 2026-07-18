#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cts-route-smoke-"))
const snapshotPath = join(temporaryDirectory, "redis-snapshot.json")
let child

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  assert.ok(port)
  return port
}

async function waitUntilReady(origin) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone route server exited early\n${child.getOutput()}`)
    }
    try {
      const response = await fetch(`${origin}/api/health/liveness`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error(`Standalone route server did not become ready\n${child.getOutput()}`)
}

async function stopServer() {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  const result = await Promise.race([
    once(child, "exit"),
    delay(15_000).then(() => { throw new Error(`Standalone route server ignored SIGTERM\n${child.getOutput()}`) }),
  ])
  const [code, signal] = result
  assert.equal(signal, null)
  assert.equal(code, 0)
}

try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      JWT_SECRET: "cts-route-smoke-secret-2026-production",
      CRON_SECRET: "cts-route-smoke-cron-secret-2026",
      ADMIN_AUTOLOGIN_ENABLED: "true",
      ALLOW_SELF_REGISTRATION: "false",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-16_000) }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  child.getOutput = () => output

  await waitUntilReady(origin)
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

  const routes = ["/", "/main", "/strategies", "/settings", "/monitoring", "/tracking", "/statistics"]
  for (const route of routes) {
    const response = await fetch(`${origin}${route}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200, `${route} returned ${response.status}`)
    assert.match(response.headers.get("content-type") || "", /^text\/html/)
    await response.arrayBuffer()
  }

  await stopServer()
  console.log(`Standalone route smoke passed (${routes.length} authenticated dashboard routes)`)
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL")
  await rm(temporaryDirectory, { recursive: true, force: true })
}
