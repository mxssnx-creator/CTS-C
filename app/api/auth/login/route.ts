import { type NextRequest, NextResponse } from "next/server"
import { verifyPassword, createToken, setSession } from "@/lib/auth"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const { email: rawEmail, password } = await request.json()
    const email = String(rawEmail || "").trim().toLowerCase()

    // Validate input
    if (!email || typeof password !== "string") {
      return NextResponse.json({ success: false, error: "Missing email or password" }, { status: 400 })
    }

    // Initialize Redis and find user
    await initRedis()
    const client = getRedisClient()

    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    const rateKey = `auth:login-attempts:${forwarded || "unknown"}`
    const attempts = await client.incr(rateKey)
    if (attempts === 1) await client.expire(rateKey, 15 * 60)
    if (attempts > 10) {
      return NextResponse.json({ success: false, error: "Too many login attempts" }, { status: 429 })
    }
    
    // O(1) lookup for current records, with a one-time compatibility scan for
    // snapshots created before the email index existed.
    const indexedUserId = await client.get(`auth:user-by-email:${email}`)
    let user = indexedUserId ? await client.hgetall(`user:${indexedUserId}`) : null
    if (!user?.email) {
      const userKeys = await client.smembers("users:all")
      for (const userId of userKeys) {
        const userData = await client.hgetall(`user:${userId}`)
        if (String(userData?.email || "").toLowerCase() === email) {
          user = userData
          await client.set(`auth:user-by-email:${email}`, String(userData.id || userId))
          break
        }
      }
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 })
    }

    // Check if user is active
    if (["false", "0"].includes(String(user.is_active).toLowerCase())) {
      return NextResponse.json({ success: false, error: "Account is disabled" }, { status: 403 })
    }

    // Verify password
    if (!user.password_hash) {
      return NextResponse.json({ success: false, error: "Password login is unavailable for this account" }, { status: 401 })
    }
    const isValid = await verifyPassword(password, user.password_hash)

    if (!isValid) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 })
    }

    // Create JWT token
    const token = await createToken({
      id: String(user.id),
      username: user.username,
      email: user.email,
      role: user.role || "user",
    })

    // Set session cookie
    await setSession(token)
    await client.del(rateKey)

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role || "user",
        },
      },
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[v0] Login error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
