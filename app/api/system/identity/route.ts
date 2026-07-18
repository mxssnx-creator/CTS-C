import { NextResponse } from "next/server"
import { getRedisClient, getRuntimeIdentity, initRedis } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  await initRedis()
  const identity = await getRuntimeIdentity()
  const persistence = getRedisClient().getPersistenceStatus()
  return NextResponse.json({
    success: true,
    data: {
      ...identity,
      persistence,
    },
  }, { headers: { "Cache-Control": "no-store" } })
}
