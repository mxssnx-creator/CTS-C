import { jwtVerify } from "jose"
import { NextRequest, NextResponse } from "next/server"

const PUBLIC_API_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/system/health",
  "/api/system/status",
]

function unauthorized(message = "Authentication required") {
  return NextResponse.json({ success: false, error: message }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  if (PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix))) return NextResponse.next()

  const authorization = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authorization === `Bearer ${cronSecret}` && path.startsWith("/api/cron/")) {
    return NextResponse.next()
  }

  const token = request.cookies.get("cts_auth")?.value
  if (!token) return unauthorized()

  const secret = process.env.JWT_SECRET?.trim()
  if (!secret || secret.length < 32 || secret === "your-secret-key-change-in-production") {
    return NextResponse.json({ success: false, error: "Authentication is not configured" }, { status: 503 })
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "cts-dashboard",
      audience: "cts-admin",
      algorithms: ["HS256"],
    })
    return NextResponse.next()
  } catch {
    return unauthorized("Session expired or invalid")
  }
}

export const config = {
  matcher: ["/api/:path*"],
}
