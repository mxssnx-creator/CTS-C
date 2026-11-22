import { LOW_RANGE_TIMEFRAMES, lowRangeSpecs } from "./origin/indications/low-range.ts"
import { LOW_RANGE_STEPS } from "./origin/indications/low-range-research.ts"
import { lowRangeExtraSpecs } from "./origin/indications/low-range-extra.ts"

export { LOW_RANGE_STEPS, LOW_RANGE_TIMEFRAMES }
export const EXTRA_LOW_RANGE_SOURCES = lowRangeExtraSpecs().map(({id,label})=>({id,label}))
export const LOW_RANGE_CATALOG = [...lowRangeSpecs().map(({id,label})=>({id,label})),...EXTRA_LOW_RANGE_SOURCES]
export const LOW_RANGE_IDS = LOW_RANGE_CATALOG.map(source=>source.id)

export const DEFAULT_LOW_RANGE_SOURCES = [
  "low-range-6-edge-turn-standalone",
  "low-range-12-failed-break-trend",
  "low-range-6-breakout-activity",
  "low-range-3-mid-reclaim-move-follow",
  "low-range-12-compression-break-breakout",
]
