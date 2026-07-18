import { GET as getSystemStatsV3 } from "../system-stats-v3/route"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

/**
 * v2 compatibility route.
 *
 * Keep a single source of truth for system stats processing by
 * delegating to the v3 implementation. This avoids divergent logic
 * across versions and preserves workflow/logistics integrity.
 */
export async function GET() {
  return getSystemStatsV3()
}
