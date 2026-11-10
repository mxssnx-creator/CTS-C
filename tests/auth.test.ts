import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowedWriteOrigin, createAuthService, type SessionStore } from "../core/auth-policy"
import { StateStore } from "../core/store"

function fixture() {
  let time = 1_000_000
  let password = "example-admin-password"
  const records = new Map<string, number>()
  const store: SessionStore = {
    createSession: (id, expires) => { records.set(id, expires) },
    hasSession: (id) => (records.get(id) || 0) > time,
    deleteSession: (id) => { records.delete(id) },
  }
  return { auth: createAuthService(store, { password: () => password, now: () => time }), records,
    advance: (amount: number) => { time += amount }, rotate: () => { password = "example-rotated-password" } }
}
function loginRequest(password = "example-admin-password") {
  return new Request("https://desk.example/api/auth/login", { method: "POST", headers: { Origin: "https://desk.example", "Content-Type": "application/json" }, body: JSON.stringify({ password }) })
}
function authenticatedRequest(cookie: string, method = "GET", origin = "https://desk.example") {
  return new Request("https://desk.example/api/terminal", { method, headers: { Cookie: cookie, Origin: origin } })
}

test("password login persists an opaque session and logout revokes the copied cookie", async () => {
  const { auth, records } = fixture()
  assert.equal(auth.requireAdmin(authenticatedRequest(""))?.status, 401)
  const login = await auth.login(loginRequest())
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie")!
  assert.match(cookie, /HttpOnly; SameSite=Strict/)
  assert.match(cookie, /Secure/)
  const bearer = cookie.split(";")[0]
  assert.equal(auth.requireAdmin(authenticatedRequest(bearer)), null)
  assert.equal(records.has(bearer.split("=")[1]), false, "database must not store reusable bearer token")
  assert.equal(auth.logout(authenticatedRequest(bearer, "POST")).status, 200)
  assert.equal(auth.requireAdmin(authenticatedRequest(bearer))?.status, 401)
})

test("password rotation and expiry invalidate existing sessions", async () => {
  const first = fixture()
  const cookie = (await first.auth.login(loginRequest())).headers.get("set-cookie")!.split(";")[0]
  first.rotate()
  assert.equal(first.auth.requireAdmin(authenticatedRequest(cookie))?.status, 401)
  const second = fixture()
  const otherCookie = (await second.auth.login(loginRequest())).headers.get("set-cookie")!.split(";")[0]
  second.advance(8 * 60 * 60 * 1000 + 1)
  assert.equal(second.auth.requireAdmin(authenticatedRequest(otherCookie))?.status, 401)
})

test("CSRF and wrong passwords cannot reach protected writes", async () => {
  const { auth } = fixture()
  assert.equal((await auth.login(loginRequest("example-incorrect"))).status, 401)
  const cookie = (await auth.login(loginRequest())).headers.get("set-cookie")!.split(";")[0]
  assert.equal(auth.requireAdmin(authenticatedRequest(cookie, "POST", "https://evil.example"))?.status, 403)
  assert.equal(auth.logout(authenticatedRequest(cookie, "POST", "https://evil.example")).status, 403)
  assert.equal(auth.requireAdmin(authenticatedRequest(cookie)), null)
  assert.equal(allowedWriteOrigin(new Request("https://desk.example/api/terminal", { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } })), false)
})

test("login rate limit expires and missing configuration never grants access", async () => {
  const { auth, advance } = fixture()
  for (let i = 0; i < 10; i++) assert.equal((await auth.login(loginRequest("example-incorrect"))).status, 401)
  assert.equal((await auth.login(loginRequest())).status, 429)
  advance(10 * 60 * 1000 + 1)
  assert.equal((await auth.login(loginRequest())).status, 200)
  const unconfigured = createAuthService({ createSession() {}, deleteSession() {}, hasSession() { return true } }, { password: () => "" })
  assert.equal((await unconfigured.login(loginRequest())).status, 503)
  assert.equal(unconfigured.requireAdmin(authenticatedRequest("cts_session=example"))?.status, 503)
})

test("oversized and malformed login bodies fail without a session", async () => {
  const { auth, records } = fixture()
  assert.equal((await auth.login(loginRequest("x".repeat(5000)))).status, 400)
  assert.equal((await auth.login(new Request("https://desk.example/api/auth/login", { method: "POST", body: "{" }))).status, 400)
  assert.equal(records.size, 0)
})

test("concurrent login attempts cannot bypass the request limit", async () => {
  const { auth } = fixture()
  const responses = await Promise.all(Array.from({ length: 20 }, () => auth.login(loginRequest("example-incorrect"))))
  assert.equal(responses.filter((response) => response.status === 401).length, 10)
  assert.equal(responses.filter((response) => response.status === 429).length, 10)
})

test("SQLite sessions survive restart and a durable logout does not resurrect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ctsc-auth-"))
  const filename = join(directory, "state.sqlite")
  let database = new StateStore(filename)
  const config = { password: () => "example-admin-password" }
  try {
    const first = createAuthService(database, config)
    const cookie = (await first.login(loginRequest())).headers.get("set-cookie")!.split(";")[0]
    database.close()
    database = new StateStore(filename)
    const second = createAuthService(database, config)
    assert.equal(second.requireAdmin(authenticatedRequest(cookie)), null)
    second.logout(authenticatedRequest(cookie, "POST"))
    database.close()
    database = new StateStore(filename)
    const third = createAuthService(database, config)
    assert.equal(third.requireAdmin(authenticatedRequest(cookie))?.status, 401)
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("standalone URL normalization retains the browser Host origin boundary", () => {
  const endpoint = "http://localhost:3001/api/auth/login"
  assert.equal(allowedWriteOrigin(new Request(endpoint, {
    method: "POST", headers: { Host: "127.0.0.1:43001", Origin: "http://127.0.0.1:43001", "Sec-Fetch-Site": "same-origin" },
  })), true)
  assert.equal(allowedWriteOrigin(new Request(endpoint, {
    method: "POST", headers: { Host: "127.0.0.1:43001", Origin: "http://evil.example", "X-Forwarded-Host": "evil.example" },
  })), false)
  assert.equal(allowedWriteOrigin(new Request(endpoint, {
    method: "POST", headers: { Host: "127.0.0.1:43001", Origin: "https://127.0.0.1:43001" },
  })), false, "Host alone cannot authorize a different scheme")
})
