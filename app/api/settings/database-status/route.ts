import { NextResponse } from "next/server"
import { initRedis, getRedisClient, isRedisConnected } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connected = isRedisConnected()
    
    let connectionCount = 0
    let schemaVersion = "0"
    
    if (connected) {
      connectionCount = await client.scard("connections")
      schemaVersion = (await client.get("_schema_version") || "0") as string
    }

    const persistence = client.getPersistenceStatus()

    return NextResponse.json({
      type: "inline-redis-snapshot",
      isConfigured: connected,
      isConnected: connected,
      url: persistence.path,
      tableCount: connectionCount,
      schemaVersion: parseInt(schemaVersion),
      persistence,
      envVars: {
        V0_REDIS_SNAPSHOT_PATH: !!process.env.V0_REDIS_SNAPSHOT_PATH,
        REDIS_SNAPSHOT_INTERVAL_MS: !!process.env.REDIS_SNAPSHOT_INTERVAL_MS,
      },
    })
  } catch (error) {
    console.error("[v0] Failed to get database status:", error)
    return NextResponse.json(
      {
        type: "inline-redis-snapshot",
        isConfigured: false,
        isConnected: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
