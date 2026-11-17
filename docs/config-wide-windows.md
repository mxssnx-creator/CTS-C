# Config-wide last-N windows — finding from CTS-A-O (17 November 2026)

## In one sentence

Judge every configuration on **its own last N closes across all symbols and sides**, not on each symbol × side
separately. In CTS-A-O this lifted the executed PF from **0.56 to 1.33** on the same market window.

## What CTS-A-O measured

Recorded BingX feed, 6 symbols, 12 h pre-history, 12 h run, every other setting equal (a causal comparison):

| | per symbol × side | config-wide |
|---|---:|---:|
| funded orders | 322 | 466 |
| executed PF | 0.56 | **1.33** |
| balance ($10 start) | $7.95 | **$13.40** |
| General | 1 order | 40 @ PF 2.79 |
| Long | 6 @ 0.50 | 96 @ PF 1.82 |
| Minimal | 287 @ 0.60 | 292 @ PF 1.10 |
| Micro | 13 @ **1.43** | 14 @ 0.21 |

Why: long-hold configurations rarely collect closes on one symbol and side, so a per-context window stopped them
executing while the busiest (weaker) configurations filled their windows and took the book. Micro was the only range
better per symbol, so CTS-A-O judges Micro on both views. Real-money promotion stays per symbol × side.
Full record: CTS-A-O `docs/config-wide-windows.md`.

## Where CTS-C stands (main b25f3b2, checked in the code)

- Every lane is keyed by **symbol × config × direction × coordination × stage** (`core/engine.ts`, `cachedLane`), and the
  stage windows (`stageLastN` base 20 / main 8 / real 8, `windowMetrics`, `qualifies`) read that lane's own samples.
- So a configuration is judged **per symbol × side** — the setting that starved long-hold configurations in CTS-A-O.

## For next work

1. **Measure a config-wide window** on one recorded window (same data, one setting changed): the stage windows read the
   configuration's own samples across symbols and directions (lineage and proofs unchanged), against today's per-lane
   windows. Report executed PF and orders per range / coordination next to each other; change the default only if it beats it.
2. If very short-target ranges do better per symbol, keep per-lane windows for them only (CTS-A-O: Micro judged on both).
3. Keep real-money promotion on the exact symbol × side lane.
4. Config-wide means the configuration's **own** closes — never another configuration's, range's or coordination's.
