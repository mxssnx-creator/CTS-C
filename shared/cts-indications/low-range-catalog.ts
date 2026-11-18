import { LOW_RANGE_IDS, LOW_RANGE_TIMEFRAMES, lowRangeSpecs } from "./origin/indications/low-range.ts"
import { LOW_RANGE_STEPS } from "./origin/indications/low-range-research.ts"

export { LOW_RANGE_IDS, LOW_RANGE_STEPS, LOW_RANGE_TIMEFRAMES }
export const LOW_RANGE_CATALOG = lowRangeSpecs().map(({ id, label }) => ({ id, label }))

export const DEFAULT_LOW_RANGE_SOURCES = [
  "low-range-6-edge-turn-standalone",
  "low-range-12-failed-break-trend",
  "low-range-6-breakout-activity",
  "low-range-3-mid-reclaim-move-follow",
  "low-range-12-compression-break-breakout",
]
