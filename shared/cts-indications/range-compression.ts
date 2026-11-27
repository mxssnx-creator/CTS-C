import type { SeriesCache } from "./origin/indications/cache.ts"

const timeframes = [1, 5, 15, 30] as const
const windows = [
  { recent: 6, baseline: 18, varianceRatio: .85, relativeVolume: 1.1 },
  { recent: 10, baseline: 30, varianceRatio: .8, relativeVolume: 1.2 },
] as const

export const RANGE_COMPRESSION_SOURCES = windows.flatMap(window =>
  (["breakout", "rejection"] as const).map(tactic => ({
    ...window, tactic, timeframes, kind: "tactic" as const,
    id: `range-compression-${tactic}-${window.recent}-${window.baseline}`,
    label: `Range compression ${tactic} · ${window.recent}/${window.baseline} bars`,
  })),
)
export const RANGE_COMPRESSION_BY_ID = new Map(RANGE_COMPRESSION_SOURCES.map(source => [source.id, source]))

function candleVariance(b: SeriesCache["b"], i: number): number {
  const highOpen = Math.log(b.h[i] / b.o[i]), lowOpen = Math.log(b.l[i] / b.o[i])
  return highOpen * Math.log(b.h[i] / b.c[i]) + lowOpen * Math.log(b.l[i] / b.c[i])
}

/** Test a closed trigger bar against two disjoint, fully observed volatility windows. */
export function rangeCompressionState(source: typeof RANGE_COMPRESSION_SOURCES[number], cache: SeriesCache): Int8Array {
  const b = cache.b, { recent, baseline, varianceRatio, relativeVolume } = source
  const variance = cache.memo("rogers-satchell", () => cache.streamMath?.vector(
    "rogers-satchell", b.n, () => null, (i, column) => { column[i] = candleVariance(b, i) },
  ) ?? Float64Array.from(b.c, (_, i) => candleVariance(b, i)))
  const threshold = b.tfMin * 60_000
  const directionAt = (i: number): number => {
    const start = i - recent - baseline, middle = i - recent
    if (start < 0 || b.t[i] - b.t[start] !== (recent + baseline) * threshold) return 0
    let olderVariance = 0, recentVariance = 0, volume = 0, high = -Infinity, low = Infinity
    for (let j = start; j < i; j++) {
      if (b.t[j + 1] - b.t[j] !== threshold) return 0
      volume += b.v[j]
      if (j < middle) olderVariance += variance[j]
      else {
        recentVariance += variance[j]
        high = Math.max(high, b.h[j])
        low = Math.min(low, b.l[j])
      }
    }
    const meanVariance = recentVariance / recent
    if (!(meanVariance > 0 && meanVariance <= varianceRatio * olderVariance / baseline &&
          volume > 0 && b.v[i] >= relativeVolume * volume / (recent + baseline))) return 0
    const noise = Math.sqrt(meanVariance) * b.c[i - 1]
    const margin = .15 * noise, span = b.h[i] - b.l[i]
    if (source.tactic === "breakout") {
      const body = b.c[i] - b.o[i]
      if (b.c[i] > high + margin && body >= .45 * span) return 1
      if (b.c[i] < low - margin && -body >= .45 * span) return -1
      return 0
    }
    if (b.l[i] < low - margin && b.h[i] < high && b.c[i] > low + margin &&
        b.c[i] > b.o[i] && b.c[i] - b.l[i] >= .55 * span) return 1
    if (b.h[i] > high + margin && b.l[i] > low && b.c[i] < high - margin &&
        b.c[i] < b.o[i] && b.h[i] - b.c[i] >= .55 * span) return -1
    return 0
  }
  return cache.streamMath?.run<{ value: Int8Array }, null>(
    source.id, b.n, ["value"], () => null, (i, cols) => { cols.value[i] = directionAt(i) }, ["value"],
  ).value ?? Int8Array.from(b.c, (_, i) => directionAt(i))
}
