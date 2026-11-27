import assert from "node:assert/strict"
import { test } from "node:test"
import { StreamMath, portedStates, type PortedBar } from "./index"
import { RANGE_COMPRESSION_SOURCES } from "./range-compression"

function prices(source: typeof RANGE_COMPRESSION_SOURCES[number]): PortedBar[] {
  const start = 1_790_000_040_000
  const baseline = Array.from({length:source.baseline + source.recent}, (_, i) => {
    const width = i < source.baseline ? 1 : .15
    return {timestamp:start+i*60_000,open:100,close:100,high:100+width,low:100-width,volume:100}
  })
  const trigger = source.tactic === "breakout"
    ? {open:100.05,high:100.42,low:100.02,close:100.4,volume:150}
    : {open:99.91,high:100.1,low:99.55,close:100.08,volume:150}
  return [...baseline,{...trigger,timestamp:start+baseline.length*60_000}]
}

function flipped(bar: PortedBar): PortedBar {
  const invert = (price: number) => 10_000 / price
  return {...bar,open:invert(bar.open),close:invert(bar.close),high:invert(bar.low),low:invert(bar.high)}
}

test("compression signals use a complete observed baseline and trigger in either direction", () => {
  for (const source of RANGE_COMPRESSION_SOURCES) {
    const bars = prices(source), last = bars.length - 1, id = source.id
    const states = (rows: PortedBar[], stream?: StreamMath) =>
      portedStates("BTC-USDT",1,rows,[id],[],stream).states[id]
    const full = states(bars)
    assert.deepEqual(full,Int8Array.from(bars,(_,i)=>i===last?1:0),id)
    assert.equal(states(bars.map(flipped)).at(-1),-1,id)
    assert.notEqual(states(bars.slice(1)).at(-1),1,"missing baseline bar")
    assert.equal(states(bars.map((bar,i)=>i===last?{...bar,volume:100}:bar)).at(-1),0,"unconfirmed volume")
    assert.equal(states(bars.map((bar,i)=>i>=last-2?{...bar,timestamp:bar.timestamp+60_000}:bar)).at(-1),0,"missing minute")
    const stream = new StreamMath()
    for (let n=1; n<=bars.length; n++) assert.deepEqual(states(bars.slice(0,n),stream),full.slice(0,n),id)
    assert.equal(portedStates("BTC-USDT",60,bars,[id]).available[id],false)
  }
})
