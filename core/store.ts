import { DatabaseSync } from "node:sqlite"
import { mkdirSync, chmodSync } from "node:fs"
import path from "node:path"

export interface Intent { id: string; status: "reserved" | "accepted" | "rejected" | "unknown"; payload: Record<string, unknown>; result: Record<string, unknown> | null; createdAt: number; updatedAt: number }
export interface RuntimeLease { owner: string; expiresAt: number; fence: number }
export class StateStore {
  readonly database: DatabaseSync
  constructor(readonly filename: string) {
    if (filename !== ":memory:") { mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); chmodSync(path.dirname(filename), 0o700) }
    this.database = new DatabaseSync(filename)
    if (filename !== ":memory:") chmodSync(filename, 0o600)
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_lease(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, fence INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS intents_status_created ON intents(status,created);
    `)
  }
  get<T>(key: string): T | null { const row = this.database.prepare("SELECT data FROM records WHERE key=?").get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) as T : null }
  set(key: string, value: unknown) { this.database.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated=excluded.updated").run(key, JSON.stringify(value), Date.now()) }
  saveEngine(state: unknown, events: unknown[] = []) {
    this.saveEngineJSON(JSON.stringify(state), events)
  }
  /** Trusted engine serialization avoids a second full-state parse/clone. */
  saveEngineJSON(serialized: string, events: unknown[] = []) {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database.prepare("INSERT INTO records VALUES('engine',?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated=excluded.updated").run(serialized, Date.now())
      const insert = this.database.prepare("INSERT INTO events(data,created) VALUES(?,?)")
      for (const event of events) insert.run(JSON.stringify(event), Date.now())
      this.database.exec("DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)")
      this.database.exec("COMMIT")
    } catch (error) { this.database.exec("ROLLBACK"); throw error }
  }
  events(limit = 100): Record<string, unknown>[] { return (this.database.prepare("SELECT data FROM events ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as { data: string }[]).map(row => JSON.parse(row.data)) }
  claimIntent(id: string, payload: Record<string, unknown>): boolean {
    // Autocommit + synchronous=FULL reaches stable storage before network I/O.
    return this.database.prepare("INSERT OR IGNORE INTO intents VALUES(?, 'reserved', ?, NULL, ?, ?)").run(id, JSON.stringify(payload), Date.now(), Date.now()).changes === 1
  }
  resolveIntent(id: string, status: Intent["status"], result: Record<string, unknown>) { this.database.prepare("UPDATE intents SET status=?, result=?, updated=? WHERE id=?").run(status, JSON.stringify(result), Date.now(), id) }
  intents(limit = 1000): Intent[] { return (this.database.prepare("SELECT * FROM intents ORDER BY created DESC LIMIT ?").all(limit) as Record<string, any>[]).map(row => ({ id: row.id, status: row.status, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null, createdAt: row.created, updatedAt: row.updated })) }
  intent(id: string): Intent | undefined {
    const row = this.database.prepare("SELECT * FROM intents WHERE id=?").get(id) as Record<string, any> | undefined
    return row ? { id: row.id, status: row.status, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null, createdAt: row.created, updatedAt: row.updated } : undefined
  }
  openExecutionIntents(): Intent[] {
    return (this.database.prepare("SELECT * FROM intents WHERE status IN ('reserved','unknown','accepted') ORDER BY created,id").all() as Record<string, any>[]).map(row => ({ id: row.id, status: row.status, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null, createdAt: row.created, updatedAt: row.updated }))
  }
  unresolvedIntents(): Intent[] {
    return (this.database.prepare("SELECT * FROM intents WHERE status IN ('reserved','unknown') ORDER BY created,id").all() as Record<string, any>[]).map(row => ({ id: row.id, status: row.status, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null, createdAt: row.created, updatedAt: row.updated }))
  }
  createSession(id: string, expires: number) { this.database.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now()); this.database.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)").run(id, expires) }
  hasSession(id: string): boolean { return Boolean(this.database.prepare("SELECT id FROM sessions WHERE id=? AND expires>?").get(id, Date.now())) }
  session(id: string): { expiresAt: number } | undefined { const row = this.database.prepare("SELECT expires FROM sessions WHERE id=? AND expires>?").get(id, Date.now()) as {expires:number}|undefined; return row ? {expiresAt:row.expires} : undefined }
  deleteSession(id: string) { this.database.prepare("DELETE FROM sessions WHERE id=?").run(id) }
  private validateLease(owner: string, ttlMs: number, now: number) {
    if (!owner || owner.length > 200 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid runtime lease")
  }
  /** Acquire/renew atomically; a competing live owner is never overwritten. */
  acquireLease(owner: string, ttlMs = 30_000, now = Date.now()): RuntimeLease | null {
    this.validateLease(owner, ttlMs, now)
    const row = this.database.prepare(`INSERT INTO runtime_lease VALUES('runtime',?,?,1)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires,
        fence=CASE WHEN runtime_lease.owner<>excluded.owner OR runtime_lease.expires<=? THEN runtime_lease.fence+1 ELSE runtime_lease.fence END
      WHERE runtime_lease.owner=excluded.owner OR runtime_lease.expires<=?
      RETURNING owner,expires AS expiresAt,fence`).get(owner, now + ttlMs, now, now) as unknown as RuntimeLease | undefined
    return row ?? null
  }
  /** Renewal cannot resurrect an expired lease; reacquisition is explicit. */
  renewLease(owner: string, ttlMs = 30_000, now = Date.now()): boolean {
    this.validateLease(owner, ttlMs, now)
    return this.database.prepare("UPDATE runtime_lease SET expires=? WHERE name='runtime' AND owner=? AND expires>?").run(now + ttlMs, owner, now).changes === 1
  }
  ownsLease(owner: string, now = Date.now()): boolean {
    return Boolean(this.database.prepare("SELECT owner FROM runtime_lease WHERE name='runtime' AND owner=? AND expires>?").get(owner, now))
  }
  releaseLease(owner: string): boolean {
    // Keep the row and fencing generation so a later owner cannot reuse a fence.
    return this.database.prepare("UPDATE runtime_lease SET expires=0 WHERE name='runtime' AND owner=?").run(owner).changes === 1
  }
  close() { this.database.close() }
}
const globalStores = globalThis as typeof globalThis & { __ctscStores?: Map<string, StateStore> }
export function getStore(): StateStore {
  const filename = path.resolve(process.env.CTS_DATA_DIR || ".data", "cts-c.sqlite")
  const stores = globalStores.__ctscStores ??= new Map()
  let instance = stores.get(filename)
  if (!instance) { instance = new StateStore(filename); stores.set(filename, instance) }
  return instance
}
export const store = {
  createSession: (id: string, expires: number) => getStore().createSession(id, expires),
  hasSession: (id: string) => getStore().hasSession(id),
  deleteSession: (id: string) => getStore().deleteSession(id),
}
export const authSessions = {
  put: (id: string, expiresAt: number) => getStore().createSession(id, expiresAt),
  get: (id: string) => getStore().session(id),
  delete: (id: string) => getStore().deleteSession(id),
}
