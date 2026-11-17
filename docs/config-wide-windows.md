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

## CTS-C Settings and evidence

- **Exact symbol and side** is the default. **Same configuration across symbols and sides** pools only settled returns of the same config, strategy coordination, stage, fee and sizing policy. **Require both windows** applies the complete own test and the complete pooled test. Micro and Low-Range can inherit or set their own preference.
- The timestamp-capped pooled window reads closes strictly before a decision. Each Main, Real and Live Set keeps its own parent on the same symbol, side and coordination. Every new exchange entry still requires the local Real window and, in mirror mode, the corresponding fresh Real position. Block and DCA add events mirror only that position's observed fills.
- Existing checkpoints without pooled timestamps retain their exact-lane samples. A pooled window collects newly timestamped evidence after it is enabled. Enabling another scope starts a separate derived cohort. Current qualifying lane counts track instantiated symbol-side Sets. Validated PF aggregates each pooled window once, even when it supports several Sets.

## Recorded market replay

Eight BingX symbols, 12 hours of prehistory and 12 hours of measured minute candles per decision. The same 200 configurations, Auto PF, 20/8/8 stage windows, independent processed Sets, four coordinations and 0.11% modeled round-trip cost were used in every arm. Mixed applies both windows to Micro and Low-Range and config-wide windows elsewhere. Forward settles count only positions opened in the measured window, with all gains and losses retained. Recorded `feed.json` SHA-256 `02ad14fd7d7ba3e89dee99026962a2ec66d8145d6beb36b17ab42a89a7d2004e`.

| Decision (UTC) | Scope | Base passing / instantiated | Passing Base PF | Modeled settles | Settled return PF | Settled cash PF | Realized drawdown (units) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-10-09 00:00 | Exact | 285 / 10,398 | 1.467 | 218 | 0.043 | 0.047 | 0.604 |
| 2026-10-09 00:00 | Config | 3,305 / 10,398 | 1.969 | 9,802 | 0.267 | 0.284 | 15.340 |
| 2026-10-09 00:00 | Mixed | 863 / 10,398 | 1.568 | 2,326 | 0.491 | 0.504 | 3.570 |
| 2026-10-13 00:00 | Exact | 234 / 9,864 | 1.387 | 2,543 | 0.579 | 0.594 | 2.849 |
| 2026-10-13 00:00 | Config | 3,380 / 9,864 | 2.907 | 27,144 | 0.695 | 0.722 | 16.035 |
| 2026-10-13 00:00 | Mixed | 1,191 / 9,864 | 2.005 | 5,789 | 1.030 | 1.001 | 4.394 |
| 2026-10-17 09:00 | Exact | 0 / 8,432 | — | 0 | — | — | — |
| 2026-10-17 09:00 | Config | 0 / 8,432 | — | 2,844 | 0.392 | 0.422 | 2.563 |
| 2026-10-17 09:00 | Mixed | 0 / 8,432 | — | 856 | 0.772 | 0.814 | 0.372 |

All nine comparisons emitted zero order intents. Mixed produced one positive realized window. Axis and Block had no profitable measured window under this mixed profile. DCA had return PF 1.280 and cash PF 1.022 on the October 13 window and lost in the other two. Exact symbol-and-side scope remains the default. These repeated historical windows and closed-bar fills provide model comparisons. Cash drawdown is the peak-to-trough sum of settled modeled P&L, without open exposure or exchange margin.

```sh
node --import tsx scripts/replay-config-stage-windows.ts /path/to/feed.json /path/to/results.json
```

The replay follows a rolling decision clock and only uses completed evidence. Parameter selection over previously examined history can overstate future performance. [Probability of Backtest Overfitting](https://escholarship.org/uc/item/4w1110bb) · [Time-series cross-validation](https://otext.robjhyndman.com/hyndsight/tscvexample/)
