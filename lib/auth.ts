import bcrypt from "bcryptjs"
import { jwtVerify, SignJWT, type JWTPayload } from "jose"
import { nanoid } from "nanoid"
import { cookies } from "next/headers"
import { ensureUniqueSiteInstance, getRedisClient, initRedis } from "@/lib/redis-db"

const AUTH_COOKIE = "cts_auth"
const AUTH_ISSUER = "cts-dashboard"
const AUTH_AUDIENCE = "cts-admin"
const DEFAULT_SESSION_SECONDS = 8 * 60 * 60

export interface User {
  id: string
  username: string
  email: string
  role: string
}

interface SessionClaims extends JWTPayload {
  id: string
  username: string
  email: string
  role: string
  sessionId: string
  siteSessionId: string
}

function sessionDurationSeconds(): number {
  const configured = Number(process.env.AUTH_SESSION_SECONDS)
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_SECONDS
  return Math.min(Math.max(Math.trunc(configured), 15 * 60), 7 * 24 * 60 * 60)
}

function jwtSecret(): Uint8Array {
  const configured = process.env.JWT_SECRET?.trim()
  if (configured && configured.length >= 32 && configured !== "your-secret-key-change-in-production") {
    return new TextEncoder().encode(configured)
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be configured with at least 32 random characters")
  }

  return new TextEncoder().encode("cts-development-only-secret-change-me-000000")
}

function claimsToUser(claims: SessionClaims): User {
  return {
    id: String(claims.id),
    username: String(claims.username),
    email: String(claims.email),
    role: String(claims.role),
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function createToken(user: User): Promise<string> {
  await initRedis()
  const { siteSessionId } = await ensureUniqueSiteInstance()
  const sessionId = `session_${nanoid(32)}`
  const seconds = sessionDurationSeconds()
  const now = new Date().toISOString()

  const token = await new SignJWT({
    id: String(user.id),
    username: user.username,
    email: user.email,
    role: user.role,
    sessionId,
    siteSessionId,
  } satisfies SessionClaims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(AUTH_ISSUER)
    .setAudience(AUTH_AUDIENCE)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(jwtSecret())

  const client = getRedisClient()
  await client.hset(`auth:session:${sessionId}`, {
    id: sessionId,
    user_id: String(user.id),
    role: user.role,
    site_session_id: siteSessionId,
    created_at: now,
    last_seen_at: now,
  })
  await client.expire(`auth:session:${sessionId}`, seconds)
  await client.sadd(`auth:sessions:user:${user.id}`, sessionId)
  await client.expire(`auth:sessions:user:${user.id}`, seconds)

  return token
}

async function verifiedClaims(token: string, requireServerSession = true): Promise<SessionClaims | null> {
  try {
    const verified = await jwtVerify(token, jwtSecret(), {
      issuer: AUTH_ISSUER,
      audience: AUTH_AUDIENCE,
      algorithms: ["HS256"],
    })
    const claims = verified.payload as SessionClaims
    if (!claims.id || !claims.sessionId || !claims.siteSessionId) return null

    if (requireServerSession) {
      await initRedis()
      const client = getRedisClient()
      const stored = await client.hgetall(`auth:session:${claims.sessionId}`)
      if (!stored?.user_id || stored.user_id !== String(claims.id)) return null
      if (stored.site_session_id !== claims.siteSessionId) return null
      await client.hset(`auth:session:${claims.sessionId}`, "last_seen_at", new Date().toISOString())
    }

    return claims
  } catch {
    return null
  }
}

export async function verifyToken(token: string): Promise<User | null> {
  const claims = await verifiedClaims(token)
  return claims ? claimsToUser(claims) : null
}

export async function getSession(): Promise<User | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(AUTH_COOKIE)?.value
  return token ? verifyToken(token) : null
}

export async function setSession(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: sessionDurationSeconds(),
    path: "/",
    priority: "high",
  })
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(AUTH_COOKIE)?.value
  if (token) {
    const claims = await verifiedClaims(token, false)
    if (claims?.sessionId) {
      await initRedis()
      const client = getRedisClient()
      await client.del(`auth:session:${claims.sessionId}`)
      await client.srem(`auth:sessions:user:${claims.id}`, claims.sessionId)
    }
  }
  cookieStore.delete(AUTH_COOKIE)
}

function tokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization")
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim()

  const cookieHeader = request.headers.get("cookie")
  if (!cookieHeader) return null
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...value] = cookie.trim().split("=")
    if (name === AUTH_COOKIE) return decodeURIComponent(value.join("="))
  }
  return null
}

export async function verifyAuth(request: Request): Promise<{
  authenticated: boolean
  user: User | null
}> {
  const token = tokenFromRequest(request)
  if (!token) return { authenticated: false, user: null }
  const user = await verifyToken(token)
  return { authenticated: Boolean(user), user }
}

export const authConfig = {
  cookieName: AUTH_COOKIE,
  issuer: AUTH_ISSUER,
  audience: AUTH_AUDIENCE,
} as const
