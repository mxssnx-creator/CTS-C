import { type NextRequest, NextResponse } from "next/server"
import { hashPassword, createToken, setSession } from "@/lib/auth"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { nanoid } from "nanoid"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    if (process.env.ALLOW_SELF_REGISTRATION !== "true") {
      return NextResponse.json({ success: false, error: "Registration is disabled" }, { status: 403 })
    }

    const { username: rawUsername, email: rawEmail, password } = await request.json()
    const username = String(rawUsername || "").trim()
    const email = String(rawEmail || "").trim().toLowerCase()

    // Validate input
    if (!username || username.length > 80 || !email || typeof password !== "string") {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: "Invalid email address" }, { status: 400 })
    }

    if (password.length < 12) {
      return NextResponse.json({ success: false, error: "Password must be at least 12 characters" }, { status: 400 })
    }

    // Initialize Redis
    await initRedis()
    const client = getRedisClient()

    // Check if user already exists
    const userKeys = await (client as any).keys("user:*")
    for (const key of userKeys) {
      const userData = await (client as any).hgetall(key)
      if (userData?.email === email || userData?.username === username) {
        return NextResponse.json({ success: false, error: "User already exists" }, { status: 409 })
      }
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password)
    const userId = nanoid()
    
    const user = {
      id: userId,
      username,
      email,
      password_hash: passwordHash,
      role: "user",
      is_active: "true",
      created_at: new Date().toISOString(),
    }

    // Store user in Redis
    const userKey = `user:${userId}`
    await (client as any).hset(userKey, user)
    
    // Add to users index
    await (client as any).sadd("users:all", userId)
    await client.set(`auth:user-by-email:${email}`, userId)

    // Create JWT token
    const token = await createToken({
      id: String(user.id),
      username: user.username,
      email: user.email,
      role: user.role,
    })

    // Set session cookie
    await setSession(token)

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      },
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[v0] Registration error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
