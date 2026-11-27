import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TradingEngine} from '../core/engine'

test('shared read-only snapshot equals the defensive copy and is not affected by later reads', () => {
  const engine = new TradingEngine({
    symbols: ['BTC-USDT'],
    catalog: {strategyIndicationTypes: ['MA_Cross'], strategyEnabledRanges: ['Micro'], strategyTpSteps: [3], strategySlRatios: [1], strategyExitModes: ['fixed']},
  })
  const bars = Array.from({length: 240}, (_, i) => {
    const close = 100 + 4 * Math.sin(i / 7)
    return {timestamp: 1700000040000 + i * 60000, open: close, high: close, low: close, close, volume: 1}
  })
  engine.processCandles('BTC-USDT', bars, {eventLimit: 0})
  const copied = engine.snapshot({laneLimit: Infinity, positionLimit: 0})
  const shared = engine.snapshot({laneLimit: Infinity, positionLimit: 0, sharedReadOnly: true})
  assert.deepEqual(shared, copied)
  assert.notEqual(shared.lanes, copied.lanes, 'the shared view must not be the copy')
  assert.ok(shared.lanes.length > 0)
})
