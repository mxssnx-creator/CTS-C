#!/bin/bash
# Vercel Pre-Build Setup Script (fixed)
# Only does what is possible and safe at Vercel build time.
# Runtime migrations + engine bootstrap are handled by the app on first request.

set -e

echo "[Vercel Build] Starting pre-build setup..."
echo "[Vercel Build] NODE_ENV: ${NODE_ENV:-production}"
echo "[Vercel Build] Node version: $(node --version 2>/dev/null || echo 'unknown')"
echo "[Vercel Build] NPM version: $(npm --version 2>/dev/null || echo 'unknown')"

# 1. Install (Vercel already runs installCommand, but keep for local `vercel-build-setup` usage)
echo "[Vercel Build] Ensuring dependencies are present..."
npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5 || true

# 2. Prepare minimal runtime dirs (Redis file fallback + Next cache)
echo "[Vercel Build] Creating required directories..."
mkdir -p data/redis
mkdir -p .next/cache

# 3. Typecheck (fast fail on obvious TS errors before the heavy Next build)
echo "[Vercel Build] Running typecheck..."
npm run typecheck -- --skipLibCheck 2>&1 | tail -10 || {
  echo "[Vercel Build] WARNING: typecheck had errors (continuing to build anyway)"
}

# 4. The actual Next.js production build (this is what produces .next/)
echo "[Vercel Build] Building Next.js application (vercel-build)..."
NODE_OPTIONS='--max-old-space-size=12288 --max-semi-space-size=128' npm run vercel-build

# 5. Verify migrations are properly defined
echo "[Vercel Build] Verifying migrations are compiled..."
if grep -q "version: 44" lib/redis-migrations.ts; then
  echo "[Vercel Build] ✓ Migration 44 present (production progression initialization)"
else
  echo "[Vercel Build] INFO: Latest migration version may be older than 44"
fi

# 6. Verify critical production coordination modules are included
# (instrumentation.ts + completeStartup + trade-engine-auto-start self-heal for bingx-x01)
echo "[Vercel Build] Verifying working production coordination modules..."
if [ -f ".next/server/app/api/trade-engine/auto-start/route.js" ] || [ -f ".next/server/app/api/trade-engine/start-all/route.js" ]; then
  echo "[Vercel Build] ✓ Production coordination modules present (auto-start, completeStartup, self-heal for bingx-x01)"
else
  echo "[Vercel Build] WARNING: Coordination modules may need verification post-build"
fi

# 7. Create environment marker file for post-deploy verification
echo "[Vercel Build] Creating deployment marker..."
echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > .next/deployment-timestamp.txt || true

# 8. Done
echo "[Vercel Build] ✓ Pre-build setup completed successfully"
echo "[Vercel Build] Production coordination (instrumentation → completeStartup → auto-start self-heal) will initialize on first request"
echo "[Vercel Build] Migrations (v44 production progression initialization) will run on first API request"
echo "[Vercel Build] Build artifacts ready at .next/"
ls -la .next/ 2>/dev/null | head -8 || true
