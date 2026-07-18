import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function POST(req: NextRequest) {
  // Server-side bootstrap endpoint. This POST is intentionally idempotent
  // and safe to call from client mounts (EngineAutoInitializer). It will
  // run the same seeding and initialization logic used in production
  // without importing `fs` or other server-only modules into client
  // bundles.
  try {
    const { seedProductionData } = await import("@/lib/production-seeder")
    await seedProductionData({ seedSettings: true, seedConnections: true, seedMarketData: true, seedProgression: true })
    // Instrumentation owns coordinator startup. The authenticated client calls
    // the idempotent auto-start endpoint separately after this seed completes;
    // avoiding a relative server-side fetch also keeps reverse-proxy origins
    // and API middleware semantics unambiguous.
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("/api/system/initialize error:", err)
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
