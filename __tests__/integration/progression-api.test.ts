import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

const baseUrl = process.env.CTS_TEST_BASE_URL || "http://127.0.0.1:3001"
let cookie = ""

before(async () => {
  const response = await fetch(`${baseUrl}/api/auth/auto-login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: "{}",
  })
  assert.equal(response.status, 200)
  cookie = response.headers.get("set-cookie")?.split(";")[0] || ""
  assert.match(cookie, /^cts_auth=/)
})

describe("authenticated API boundary", () => {
  test("rejects a protected route without a session", async () => {
    const response = await fetch(`${baseUrl}/api/system/identity`)
    assert.equal(response.status, 401)
  })

  test("returns the session and durable site identity", async () => {
    const headers = { Cookie: cookie }
    const [me, identity] = await Promise.all([
      fetch(`${baseUrl}/api/auth/me`, { headers }),
      fetch(`${baseUrl}/api/system/identity`, { headers }),
    ])
    assert.equal(me.status, 200)
    assert.equal(identity.status, 200)
    const meBody = await me.json() as any
    const identityBody = await identity.json() as any
    assert.equal(meBody.data.user.role, "admin")
    assert.match(identityBody.data.siteSessionId, /^site_/)
    assert.match(identityBody.data.runtimeInstanceId, /^runtime_/)
  })

  test("logout revokes the server-side session", async () => {
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    })
    assert.equal(logout.status, 200)
    const staleSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })
    assert.equal(staleSession.status, 401)
  })
})
