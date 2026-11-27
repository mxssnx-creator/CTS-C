export const MIN_WARMUP_CANDLES = 100
export const DEFAULT_WARMUP_CANDLES = 7 * 1440
export const MAX_WARMUP_CANDLES = 14 * 1440

export function validWarmupCount(count) {
  return Number.isInteger(count) && count >= MIN_WARMUP_CANDLES && count <= MAX_WARMUP_CANDLES
}
