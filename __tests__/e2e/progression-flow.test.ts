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
})

describe("single-site continuity under concurrent reads", () => {
  test("twenty authenticated reads return one site identity", async () => {
    const startedAt = Date.now()
    const responses = await Promise.all(Array.from({ length: 20 }, () =>
      fetch(`${baseUrl}/api/system/identity`, { headers: { Cookie: cookie } })
    ))
    assert.ok(Date.now() - startedAt < 30_000)
    responses.forEach((response) => assert.equal(response.status, 200))
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<any>))
    const siteIds = new Set(bodies.map((body) => body.data.siteSessionId))
    const runtimeIds = new Set(bodies.map((body) => body.data.runtimeInstanceId))
    assert.equal(siteIds.size, 1)
    assert.equal(runtimeIds.size, 1)
  })
})
