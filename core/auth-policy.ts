import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export interface SessionStore {
  createSession(id: string, expires: number): void
  hasSession(id: string): boolean
  deleteSession(id: string): void
}
export interface AuthOptions {
  password(): string | undefined
  now?(): number
  secureCookie?(): boolean
}
const COOKIE = "cts_session"
const EIGHT_HOURS = 8 * 60 * 60 * 1_000
const WINDOW = 10 * 60 * 1_000
const MAX_FAILURES = 10

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } })
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }

export function allowedWriteOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false
  const origin = request.headers.get("origin")
  if (!origin) return !fetchSite || fetchSite === "none"
  try {
    const source = new URL(origin)
    if (!["http:", "https:"].includes(source.protocol) || source.origin !== origin) return false
    const target = new URL(request.url)
    if (source.origin === target.origin) return true
    // Next's standalone server can normalize request.url to localhost even
    // when the browser reached 127.0.0.1 or the configured public host. The
    // actual Host header retains that authority; forwarded headers do not.
    const host = request.headers.get("host")?.trim().toLowerCase()
    if (source.protocol === target.protocol && host && source.host === host) return true
    // Trusted origins are explicit complete origins, never arbitrary forwarded
    // headers. This supports a private reverse proxy without trusting its input.
    const configured = (process.env.CTS_TRUSTED_ORIGINS || "").split(",").map((value) => value.trim())
    return configured.includes(source.origin)
  } catch { return false }
}
async function loginBody(request: Request): Promise<{ password?: unknown }> {
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 4096) { await reader.cancel(); throw new Error("too large") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export function createAuthService(sessions: SessionStore, options: AuthOptions) {
  const now = options.now || Date.now
  let failures: number[] = []
  function configuredPassword(): string | null {
    const password = options.password()
    return password && password.length >= 12 ? password : null
  }
  function sessionId(request: Request): string | null {
    const configured = configuredPassword()
    if (!configured) return null
    const cookie = request.headers.get("cookie") || ""
    const token = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
    // Password rotation invalidates existing cookies. Only a one-way digest of
    // the unpredictable token is persisted, never a reusable bearer secret.
    return digest(`${configured}\0${token}`)
  }
  function cookie(value: string, request: Request, expires = false): string {
    const secure = options.secureCookie?.() || new URL(request.url).protocol === "https:"
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires ? 0 : EIGHT_HOURS / 1000}${secure ? "; Secure" : ""}`
  }
  function requireAdmin(request: Request): Response | null {
    if (!allowedWriteOrigin(request)) return json({ error: "Cross-origin write rejected" }, 403)
    if (!configuredPassword()) return json({ error: "Set CTS_ADMIN_PASSWORD to at least 12 characters before signing in." }, 503)
    const id = sessionId(request)
    if (!id || !sessions.hasSession(id)) return json({ authenticated: false, error: "Sign in to continue." }, 401)
    return null
  }
  async function login(request: Request): Promise<Response> {
    if (!allowedWriteOrigin(request)) return json({ error: "Cross-origin write rejected" }, 403)
    const expected = configuredPassword()
    if (!expected) return json({ error: "Set CTS_ADMIN_PASSWORD to at least 12 characters before signing in." }, 503)
    const time = now()
    failures = failures.filter((at) => time - at < WINDOW)
    if (failures.length >= MAX_FAILURES) return json({ error: "Too many unsuccessful attempts. Try again shortly." }, 429, { "Retry-After": String(Math.max(1, Math.ceil((failures[0] + WINDOW - time) / 1000))) })
    // Reserve before reading the body: concurrent requests cannot all pass a
    // check-then-increment limit while awaiting their streams.
    failures.push(time)
    let supplied: unknown
    try { supplied = (await loginBody(request)).password } catch { return json({ error: "Invalid login request." }, 400) }
    if (typeof supplied !== "string" || supplied.length > 1024) return json({ error: "Invalid login request." }, 400)
    if (!timingSafeEqual(Buffer.from(digest(supplied), "hex"), Buffer.from(digest(expected), "hex"))) {
      return json({ authenticated: false, error: "Incorrect password." }, 401)
    }
    failures = []
    const oldId = sessionId(request)
    if (oldId) sessions.deleteSession(oldId)
    const token = randomBytes(32).toString("hex")
    sessions.createSession(digest(`${expected}\0${token}`), time + EIGHT_HOURS)
    return json({ authenticated: true, user: { name: "Administrator", role: "admin" } }, 200, { "Set-Cookie": cookie(token, request) })
  }
  function logout(request: Request): Response {
    if (!allowedWriteOrigin(request)) return json({ error: "Cross-origin write rejected" }, 403)
    const id = sessionId(request)
    if (id) sessions.deleteSession(id)
    return json({ authenticated: false, user: null }, 200, { "Set-Cookie": cookie("", request, true) })
  }
  function currentUser(request: Request): Response {
    const rejected = requireAdmin(request)
    return rejected || json({ authenticated: true, user: { name: "Administrator", role: "admin" } })
  }
  return { requireAdmin, login, logout, currentUser }
}
