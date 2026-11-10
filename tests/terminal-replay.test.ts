import assert from "node:assert/strict"
import { test } from "node:test"
import { runTerminalReplay,runTerminalReplayAsync } from "../core/terminal-replay"
const settings = { strategyEnabledRanges: ["Micro"], strategyTpSteps: [3], strategySlRatios: [.2], strategyExitModes: ["fixed"], strategyIndicationTypes: ["MA_Cross"], mainEvalPosCount: 1 }
const candles = Array.from({length: 240}, (_, i) => { const close = 100 + 8 * Math.sin(i / 9); return { time: 1700000000 + i * 60, open: close, high: close, low: close, close, volume: 1 } })
test("held-out returns never change training or parameter shortlist", () => {
  const first = runTerminalReplay("BTC-USDT", candles, settings)
  const changed = candles.map((c, i) => i < 156 ? c : {...c, open: 100, high: 100, low: 100, close: 100})
  const second = runTerminalReplay("BTC-USDT", changed, settings)
  assert.equal(first.executionEligible, false)
  assert.equal(first.configurations, 1)
  assert.deepEqual(first.rows.map(r => [r.id, r.training]), second.rows.map(r => [r.id, r.training]))
  assert.equal(first.holdoutCandles, 84)
  assert.throws(() => runTerminalReplay("BTC-USDT", candles.slice(0, 20), settings), /100/)
})
test("cooperative research matches synchronous results and permits other event-loop work",async()=>{
  let ticked=false
  setImmediate(()=>{ticked=true})
  const result=await runTerminalReplayAsync("BTC-USDT",candles,settings)
  assert.equal(ticked,true)
  assert.deepEqual(result,runTerminalReplay("BTC-USDT",candles,settings))
  const abort=new AbortController();abort.abort()
  await assert.rejects(()=>runTerminalReplayAsync("BTC-USDT",candles,settings,abort.signal),/abort/i)
})
