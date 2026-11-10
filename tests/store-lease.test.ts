import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { StateStore } from "../core/store"

test("independent SQLite connections cannot acquire the same active writer lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctsc-lease-"))
  const first = new StateStore(join(directory, "state.sqlite"))
  const second = new StateStore(join(directory, "state.sqlite"))
  try {
    const a = first.acquireLease("owner-a", 30_000, 10_000)!
    assert.equal(a.owner, "owner-a")
    assert.equal(second.acquireLease("owner-b", 30_000, 10_001), null)
    assert.equal(second.renewLease("owner-b", 30_000, 10_001), false)
    assert.equal(second.releaseLease("owner-b"), false)
    assert.equal(first.ownsLease("owner-a", 10_002), true)
    // Sessions and read APIs remain available without owning the trading lease.
    second.createSession("example-session", Date.now() + 30_000)
    assert.equal(first.hasSession("example-session"), true)
    assert.equal(first.releaseLease("owner-a"), true)
    const b = second.acquireLease("owner-b", 30_000, 10_003)!
    assert.ok(b.fence > a.fence)
    assert.equal(first.ownsLease("owner-a", 10_003), false)
    assert.equal(first.renewLease("owner-a", 30_000, 10_004), false)
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) }
})

test("stale owners cannot renew or interfere after takeover", () => {
  const store = new StateStore(":memory:")
  try {
    const original = store.acquireLease("owner-a", 1000, 1000)!
    assert.equal(store.renewLease("owner-a", 1000, 2000), false)
    assert.equal(store.ownsLease("owner-a", 2000), false)
    const takeover = store.acquireLease("owner-b", 1000, 2000)!
    assert.ok(takeover.fence > original.fence)
    assert.equal(store.acquireLease("owner-a", 1000, 2001), null)
    assert.equal(store.releaseLease("owner-a"), false)
    assert.equal(store.renewLease("owner-b", 1000, 2500), true)
    assert.equal(store.ownsLease("owner-b", 3499), true)
    assert.equal(store.ownsLease("owner-b", 3500), false)
  } finally { store.close() }
})

test("owner restart requires a new lease generation and engine JSON persists faithfully", () => {
  const store = new StateStore(":memory:")
  try {
    const first = store.acquireLease("owner-a", 1000, 1000)!
    const renewed = store.acquireLease("owner-a", 1000, 1500)!
    assert.equal(renewed.fence, first.fence)
    const reacquired = store.acquireLease("owner-a", 1000, 2500)!
    assert.ok(reacquired.fence > first.fence)
    store.saveEngineJSON('{"version":1,"nested":{"value":2}}', [{ type: "checked" }])
    assert.deepEqual(store.get("engine"), { version: 1, nested: { value: 2 } })
    assert.equal(store.events().length, 1)
    assert.throws(() => store.acquireLease("", 1000, 10))
    assert.throws(() => store.acquireLease("owner", 0, 10))
  } finally { store.close() }
})
