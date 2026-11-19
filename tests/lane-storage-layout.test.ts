import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { StateStore } from "../core/store"

const withTempStore = (run: (filename: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cts-c-lane-storage-"))
  try { run(path.join(directory, "state.sqlite")) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

test("fresh lane storage has no duplicate rowid index", () => withTempStore(filename => {
  const store = new StateStore(filename)
  try {
    const row = store.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='engine_lanes'"
    ).get() as { sql: string }
    assert.match(row.sql, /WITHOUT ROWID/i)
    assert.equal(store.database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND tbl_name='engine_lanes'"
    ).get(), { count: 0 })
  } finally { store.close() }
}))

test("legacy lane rows migrate exactly into the bounded table", () => withTempStore(filename => {
  const legacy = new DatabaseSync(filename)
  legacy.exec("CREATE TABLE engine_lanes(id TEXT PRIMARY KEY,data TEXT NOT NULL)")
  const insert = legacy.prepare("INSERT INTO engine_lanes VALUES(?,?)")
  insert.run("base|S01-USDT|long|config-a", "lane-a")
  insert.run("real|S12-USDT|short|config-z", "lane-z")
  legacy.close()

  const store = new StateStore(filename)
  try {
    const schema = store.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='engine_lanes'"
    ).get() as { sql: string }
    assert.match(schema.sql, /WITHOUT ROWID/i)
    assert.deepEqual(store.database.prepare(
      "SELECT id,data FROM engine_lanes ORDER BY id"
    ).all(), [
      { id: "base|S01-USDT|long|config-a", data: "lane-a" },
      { id: "real|S12-USDT|short|config-z", data: "lane-z" },
    ])
  } finally { store.close() }
}))
