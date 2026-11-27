import assert from "node:assert/strict";
import { test } from "node:test";
import { portedStates, StreamMath } from "./index.ts";
import { REVERSAL_SOURCES, trendReversalSeries } from "../cts-reversal/reversal.ts";

test("ordinary and Signal identities share causal math with separate immutable vectors", () => {
  let seed = 291, close = 100;
  const random = () => ((seed = Math.imul(1664525, seed) + 1013904223 >>> 0) / 2 ** 32);
  const rows = Array.from({ length: 100 }, (_, i) => {
    const open = close;
    close += Math.sin(i / 3) * .23 + (random() - .5) * 1.2;
    return { timestamp: 1_790_000_040_000 + i * 60_000, open,
      high: Math.max(open, close) + random() * .25, low: Math.min(open, close) - random() * .25, close, volume: 5 + random() * 40 };
  });
  const source = REVERSAL_SOURCES.find(x => x.tactic === "structure" && x.period === 6)!;
  const alias = "sig-" + source.id;
  const stream = new StreamMath();
  const partial = portedStates("ETH-USDT", 1, rows.slice(0, 61), [source.id, alias], [], stream);
  const full = portedStates("ETH-USDT", 1, rows, [source.id, alias], [], stream);
  const b = { t: rows.map(x => x.timestamp), o: rows.map(x => x.open), h: rows.map(x => x.high),
    l: rows.map(x => x.low), c: rows.map(x => x.close), v: rows.map(x => x.volume) };
  const oracle = trendReversalSeries(b, source.period, source.tactic, 60_000);
  assert.ok(oracle.some(Boolean));
  assert.deepEqual(full.states[source.id], oracle);
  assert.deepEqual(full.states[alias], oracle);
  assert.notEqual(full.states[source.id], full.states[alias]);
  assert.deepEqual(partial.states[alias], oracle.slice(0, 61));
});
