// CRITICAL: Define totalStrategiesEvaluated globally BEFORE any other code loads
// This fixes ReferenceError in stale closures from previous code versions

declare global { var totalStrategiesEvaluated: number }
;(globalThis as any).totalStrategiesEvaluated = 0

// NOTE: Previously this module pre-emptively cleared `globalThis.__engine_timers`
// on every import. That nuked the timer loops of any *live* engine that had
// already armed itself in the same process — a frequent cause of the
// "engines silently stop running" symptom on dev hot-reload and on serverless
// cold-warm transitions. The clear was always destructive and never useful:
// real timer cleanup belongs to `EngineManager.stop()`. The clear is now
// removed; in-flight engines keep running across module reload.

function isNextBuildPhase(): boolean {
  const npmLifecycle = process.env.npm_lifecycle_event || ""
  const argv = process.argv.join(" ")
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    npmLifecycle === "build" ||
    npmLifecycle === "vercel-build" ||
    /\bnext(\.js)?\s+build\b/.test(argv)
  )
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return
  }

  const npmLifecycle = process.env.npm_lifecycle_event || ""
  const isNextBuild =
    process.env.NEXT_PHASE === "phase-production-build" ||
    npmLifecycle === "build" ||
    npmLifecycle === "vercel-build" ||
    process.argv.some((arg) => arg === "build" || arg.endsWith("/next") || arg.endsWith("\\next")) &&
      process.argv.includes("build")

  if (isNextBuildPhase()) {
    // `next build` imports instrumentation while collecting page data. Running
    // Redis migrations/startup/auto-start here makes deployment builders spend
    // tens of seconds doing runtime work and can hit hosted builder deadlines
    // (observed on kilo.ai). Runtime startup still runs on `next start` /
    // serverless invocation where npm_lifecycle_event is not build.
    console.log("[v0] [Instrumentation] Build phase detected — skipping runtime Redis/engine startup")
    return
  }

  // Initialize production error handlers FIRST (before any other startup)
  try {
    const { default: ProductionErrorHandler } = await import(/* webpackMode: "eager" */ "@/lib/error-handling-production")
    ProductionErrorHandler.initialize()
  } catch (error) {
    console.error("[ERROR_HANDLER] Failed to initialize production error handlers:", error)
  }

  // Initialize error handling integration (circuit breakers, metrics, etc.)
  try {
    const { initializeErrorHandling } = await import(/* webpackMode: "eager" */ "@/lib/error-handling-integration")
    initializeErrorHandling()
  } catch (error) {
    console.error("[ERROR_INTEGRATION] Failed to initialize error handling integration:", error)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Boot-time core init.
  //
  // 1. Initialize the trade-engine coordinator singleton FIRST.
  //    This publishes __engine_manager_instance.isEngineRunning to
  //    globalThis, which the Redis snapshot loader checks to prevent
  //    reloading stale lock state while an engine is running.
  //
  // 2. completeStartup(): initialises Redis (which runs migrations AND
  //    restores the on-disk snapshot via loadFromDisk) and prepares the
  //    trade-engine coordinator singleton — without auto-starting any
  //    engine. Without this hook the coordinator and snapshot only come
  //    online when someone hits a route, which can be many minutes after
  //    a redeploy.
  //
  // 3. initializeTradeEngineAutoStart(): starts the auto-start MONITOR
  //    only — it does NOT start engines on its own. The monitor scans for
  //    connections with `is_enabled_dashboard=1` and (re-)starts ONLY
  //    those, so disabled connections stay disabled across restarts.
  //
  // Failures here are logged but never thrown — boot must not crash the
  // runtime even if Redis hydration or the coordinator fail. Subsequent
  // route hits will retry.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const { getGlobalTradeEngineCoordinator } = await import(/* webpackMode: "eager" */ "@/lib/trade-engine")
    getGlobalTradeEngineCoordinator()
    console.log("[v0] [Instrumentation] Trade engine coordinator initialized")
  } catch (error) {
    console.error("[Instrumentation] coordinator init failed:", error)
  }

  try {
    const { completeStartup } = await import(/* webpackMode: "eager" */ "@/lib/startup-coordinator")
    await completeStartup()
  } catch (error) {
    console.error("[Instrumentation] completeStartup failed:", error)
  }

  try {
    const { initializeTradeEngineAutoStart } = await import(/* webpackMode: "eager" */ "@/lib/trade-engine-auto-start")
    await initializeTradeEngineAutoStart()
  } catch (error) {
    console.error("[Instrumentation] auto-start init failed:", error)
  }

  return
}
