import { DatabaseSync } from "node:sqlite"
import {createHash} from 'node:crypto'
import { mkdirSync, chmodSync } from "node:fs"
import path from "node:path"
import type {EngineState,StrategyConfig} from "./types"

export interface Intent { id: string; status: "reserved" | "accepted" | "rejected" | "unknown"; payload: Record<string, unknown>; result: Record<string, unknown> | null; createdAt: number; updatedAt: number }
export interface RuntimeLease { owner: string; expiresAt: number; fence: number }
export class StateStore {
  readonly database: DatabaseSync
  private loadedToken:string|null=null
  constructor(readonly filename: string) {
    if (filename !== ":memory:") { mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); chmodSync(path.dirname(filename), 0o700) }
    this.database = new DatabaseSync(filename)
    if (filename !== ":memory:") chmodSync(filename, 0o600)
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS market_trade_bars(symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(symbol,timestamp));
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS engine_lanes(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_lease(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, fence INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS intents_status_created ON intents(status,created);
    `)
  }
  saveTradeBar(symbol:string,bar:import('./trade-stream').TradeBar):void{
    this.database.prepare('INSERT OR IGNORE INTO market_trade_bars VALUES(?,?,?)').run(symbol,bar.timestamp,JSON.stringify(bar))
    this.database.prepare('DELETE FROM market_trade_bars WHERE symbol=? AND timestamp<?').run(symbol,bar.timestamp-3*86400000)
  }
  tradeBars(symbol:string,limit=4320):import('./trade-stream').TradeBar[]{
    return (this.database.prepare('SELECT data FROM market_trade_bars WHERE symbol=? ORDER BY timestamp DESC LIMIT ?').all(symbol,limit) as {data:string}[]).reverse().map(r=>JSON.parse(r.data))
  }
  getRaw(key: string): string | null { const row = this.database.prepare("SELECT data FROM records WHERE key=?").get(key) as { data: string } | undefined; if(key==='engine'&&row?.data.startsWith('{"checkpointFormat":"lane-rows-v1"'))return JSON.stringify(this.loadEngineState())
    return row?.data ?? null }
  hasLaneCheckpoint():boolean{
    const row=this.database.prepare("SELECT substr(data,1,80) AS prefix FROM records WHERE key='engine'").get() as {prefix:string}|undefined
    return row?.prefix.startsWith('{"checkpointFormat":"lane-rows-v1"')??false
  }
  loadEngineState():EngineState|null{
    const ownTransaction=!this.database.isTransaction
    if(ownTransaction)this.database.exec('BEGIN')
    try{
    const row=this.engineRecord()
    if(!row){this.loadedToken=null;if(ownTransaction)this.database.exec('COMMIT');return null}
    const decoded=JSON.parse(row.data),state:EngineState=decoded.checkpointFormat==='lane-rows-v1'?{...decoded.state,lanes:{}}:decoded
    if(decoded.checkpointFormat==='lane-rows-v1')for(const item of this.database.prepare('SELECT id,data FROM engine_lanes').iterate() as Iterable<{id:string;data:string}>){const lane=JSON.parse(item.data);if(lane.id!==item.id)throw new Error('Checkpoint lane identity mismatch');state.lanes[item.id]=lane}
    const configs=new Map<string,StrategyConfig>()
    for(const id in state.lanes??{}){const lane=state.lanes[id]
      const identity=JSON.stringify(lane.config),shared=configs.get(identity)
      if(shared)lane.config=shared;else configs.set(identity,lane.config)
    }
    this.loadedToken=this.recordToken(row)
    if(ownTransaction)this.database.exec('COMMIT')
    return state
    }catch(error){if(ownTransaction)this.database.exec('ROLLBACK');throw error}
  }
  private engineRecord(){return this.database.prepare("SELECT data,(SELECT data FROM records WHERE key='engine-revision') AS revision FROM records WHERE key='engine'").get() as {data:string;revision:string|null}|undefined}
  private recordToken(row:{data:string;revision:string|null}){return (row.revision??'legacy')+':'+createHash('sha256').update(row.data).digest('hex')}
  checkpointToken():string|null{const row=this.engineRecord();return row?this.recordToken(row):null}
  loadedCheckpointToken():string|null{return this.loadedToken}
  private advanceEngineRevision(){this.database.prepare("INSERT INTO records VALUES('engine-revision','1',?) ON CONFLICT(key) DO UPDATE SET data=CAST(CAST(data AS INTEGER)+1 AS TEXT),updated=excluded.updated").run(Date.now())}
  /** Migration rows stay invisible until the final metadata transaction. No full-state rewrite. */
  migrateLaneCheckpoint(metadata:string,lanes:Iterable<{id:string;data:string}>,events:unknown[],settings:unknown,guard:()=>void):void{
    if(this.hasLaneCheckpoint())throw new Error('Checkpoint is already migrated')
    guard();this.database.exec('DELETE FROM engine_lanes')
    const insert=this.database.prepare('INSERT INTO engine_lanes VALUES(?,?)')
    let batch:{id:string;data:string}[]=[],guardedAt=Date.now()
    const timelyGuard=()=>{if(Date.now()-guardedAt>=500){guard();guardedAt=Date.now()}}
    const flush=()=>{if(!batch.length)return;guard();this.database.exec('BEGIN IMMEDIATE');try{for(const row of batch){timelyGuard();insert.run(row.id,row.data)}guard();this.database.exec('COMMIT')}catch(error){this.database.exec('ROLLBACK');throw error}batch=[]}
    for(const lane of lanes){timelyGuard();batch.push(lane);if(batch.length>=500)flush()}
    flush();this.saveLaneCheckpoint(metadata,[],events,settings,guard)
  }
  saveLaneCheckpoint(metadata:string,lanes:Iterable<{id:string;data:string}>,events:unknown[],settings:unknown,guard:()=>void):void{
    guard();this.database.exec('BEGIN IMMEDIATE')
    try{
      const insert=this.database.prepare('INSERT INTO engine_lanes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      let count=0,guardedAt=Date.now();for(const lane of lanes){
        // Serialization and large retained lane rows can take longer than a lease before 500 rows exist.
        // Check elapsed work as well as count; an expired/stolen owner still fails before the row is written.
        if(Date.now()-guardedAt>=500){guard();guardedAt=Date.now()}
        insert.run(lane.id,lane.data);if(++count%500===0){guard();guardedAt=Date.now()}
      }
      this.database.prepare("INSERT INTO records VALUES('engine',?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated=excluded.updated").run('{"checkpointFormat":"lane-rows-v1","state":'+metadata+'}',Date.now())
      this.advanceEngineRevision()
      this.set('engine-settings',settings)
      const eventInsert=this.database.prepare('INSERT INTO events(data,created) VALUES(?,?)');for(const event of events)eventInsert.run(JSON.stringify(event),Date.now())
      this.database.exec('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)')
      guard();this.database.exec('COMMIT')
    }catch(error){this.database.exec('ROLLBACK');throw error}
  }
  get<T>(key: string): T | null { const data = this.getRaw(key); return data === null ? null : JSON.parse(data) as T }
  set(key: string, value: unknown) { this.database.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated=excluded.updated").run(key, JSON.stringify(value), Date.now()) }
  saveEngine(state: unknown, events: unknown[] = []) {
    this.saveEngineJSON(JSON.stringify(state), events)
  }
  /** Trusted engine serialization avoids a second full-state parse/clone. */
  saveEngineJSON(serialized: string, events: unknown[] = [], settings?:unknown) {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database.prepare("INSERT INTO records VALUES('engine',?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated=excluded.updated").run(serialized, Date.now())
      this.advanceEngineRevision()
      if(settings!==undefined)this.set('engine-settings',settings)
      const insert = this.database.prepare("INSERT INTO events(data,created) VALUES(?,?)")
      for (const event of events) insert.run(JSON.stringify(event), Date.now())
      this.database.exec("DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)")
      this.database.exec("COMMIT")
    } catch (error) { this.database.exec("ROLLBACK"); throw error }
  }
  engineSettings():import('./types').EngineSettings|null {
    const saved=this.get<import('./types').EngineSettings>('engine-settings')
    if(saved)return saved
    const row=this.database.prepare("SELECT COALESCE(json_extract(data,'$.settings'),json_extract(data,'$.state.settings')) AS data FROM records WHERE key='engine'").get() as {data:string|null}|undefined
    return row?.data?JSON.parse(row.data):null
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
export function getStore(connectionId='bingx-x02'): StateStore {
  if(!['bingx-x02','bingx-x01'].includes(connectionId))throw new Error('Unknown connection')
  const filename = path.resolve(process.env.CTS_DATA_DIR || ".data", ...(connectionId==='bingx-x01'?['x01']:[]),"cts-c.sqlite")
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
