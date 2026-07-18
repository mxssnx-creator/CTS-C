import { NextRequest, NextResponse } from "next/server"
import { createToken, setSession, type User } from "@/lib/auth"
import { getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function requestIsSameOrigin(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false

  const origin = request.headers.get("origin")
  if (!origin) return true
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host")
  const forwardedProto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "")
  return Boolean(forwardedHost) && origin === `${forwardedProto}://${forwardedHost}`
}

export async function POST(request: NextRequest) {
  if (process.env.ADMIN_AUTOLOGIN_ENABLED !== "true") {
    return NextResponse.json({ success: false, error: "Admin auto-login is disabled" }, { status: 401 })
  }
  if (!requestIsSameOrigin(request)) {
    return NextResponse.json({ success: false, error: "Cross-origin auto-login rejected" }, { status: 403 })
  }

  try {
    await initRedis()
    const client = getRedisClient()
    const now = new Date().toISOString()
    const user: User = {
      id: "admin-autologin",
      username: process.env.ADMIN_USERNAME?.trim() || "Administrator",
      email: process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@localhost",
      role: "admin",
    }

    await client.hset(`user:${user.id}`, {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      is_active: "true",
      auth_mode: "auto-login",
      updated_at: now,
      created_at: (await client.hget(`user:${user.id}`, "created_at")) || now,
    })
    await client.sadd("users:all", user.id)
    await client.set(`auth:user-by-email:${user.email}`, user.id)

    const token = await createToken(user)
    await setSession(token)

    return NextResponse.json({ success: true, data: { user } }, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    console.error("[Auth] Admin auto-login failed:", error)
    return NextResponse.json({ success: false, error: "Admin auto-login failed" }, { status: 500 })
  }
}
