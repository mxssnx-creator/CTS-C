# Five-day indication simulation, 27 November 2026

## Scope

- 30 BingX VST symbols, observed 1-minute candles only. 3 days (4,320 minutes) of prehistory are warmup, then 5 scored days (7,200 minutes), 22–27 November UTC.
- 23 indication types: 18 core and technical types, Tactic, Inverse, Signals, Low-Range and Trend-Reversal.
- Every range (Micro, Low-Range, Minimal, Short, Normal, Long, Wide), exit mode, direction and coordination (Normal, Axis, Block, DCA, Relate) is enabled.
- 6,075 configurations per symbol, 690 symbol × indication jobs, all completed with no errors.
- Results are paper replays only. Nothing was submitted to an exchange.

## What is not complete

- **Fees are unverified.** No dedicated x02 credentials were available, so the run uses documented defaults (0.02% maker, 0.05% taker, 10% slippage). `run.json` marks them `documented-defaults-unverified`.
- **Grid is reduced.** Full 29 TP steps × 21 SL ratios is not runnable. The run uses 8 TP steps (2, 3, 5, 8, 12, 18, 24, 30) and 3 SL ratios (0.6, 1, 1.4). Tactic and Inverse use their declared default sources. Trend-Reversal uses all 21 of its sources.
- **Exec exists only in one engine.** The `exec-branches` engine is the only one that reaches Exec, with a small Exec window grid. The two `processed-sets` engines never reach Exec by design.
- **Exec and Live are sparse.** See the zero-result list below.

## Engines

| Engine | Gate | Block behavior |
|---|---|---|
| processed-pyramid-20-8-8 | processed-sets | pyramid |
| processed-rounds-20-8-8 | processed-sets | rounds |
| exec-branches-pyramid-20-8-8 | exec-branches | pyramid |

Each engine also reports a frozen prehistory subset (`prehistory-selected-*`), selected from Base prehistory only (at least 20 closes and PF 1.1).

## Five-day totals (all configurations)

| Engine | Base closes / PF | Main closes / PF | Real closes / PF | Exec closes / PF | Live closes / PF |
|---|---|---|---|---|---|
| processed-pyramid | 121,368,499 / 0.453 | 73,178,853 / 0.422 | 61,907,041 / 0.414 | — | 6,695,869 / 0.498 |
| processed-rounds | 121,316,637 / 0.488 | 79,873,850 / 0.443 | 68,783,759 / 0.432 | — | 7,932,387 / 0.505 |
| exec-branches | 50,516,200 / 0.436 | 3,730,851 / 0.573 | 949,844 / 0.840 | 844,833 / 2.223 | 3,702 / 1.574 |

Exec PF is pooled over one engine's closes and is dominated by a few buckets. Per bucket, Exec PF ranges from 0.003 to 80.058. A PF of 999 is the sentinel for windows with no losses and is not a finite result. Read the per-bucket lines before relying on any single pooled number.

## Zero-result check

No type, range, coordination or source is empty at every stage. The gaps are per stage.

| Engine | Stage | Zero-close values |
|---|---|---|
| processed-pyramid / processed-rounds | Exec | Exec does not exist in these engines (expected) |
| processed-pyramid / processed-rounds | Real | Break_Reversal |
| processed-pyramid / processed-rounds | Live | Break_Reversal, Wide |
| exec-branches | Real | Break_Reversal, Wide |
| exec-branches | Exec | RSI_Band, Trend_Fade, Break_Reversal, Long, Wide |
| exec-branches | Live | RSI_Band, MA_Cross, Bollinger_Bounce, MA_Inverse, MACD_Signal, RSI_Momentum, Trend_Pullback, Trend_Fade, Break, Trend_Efficiency, Break_Retest, Break_Volume, Break_Reversal, Break_ATR, Break_Continuation, Tactic, Trend-Reversal, Normal, Long, Wide |

**Live coverage.** In the `exec-branches` engine, every Live coordination has sets but none meets its sample requirement: Normal 310, Block 308, DCA 313, Relate 310, Axis 134 sets, all with zero enough samples. Live therefore cannot produce closes in that engine. This is a model outcome and needs investigation before anything is promoted.

**Axis.** Axis is thin past Base. In the processed-set engines, Axis has Base sets but almost no Main or Real sets with enough samples.

## Files

- `docs/FIVE-DAY-SIMULATION-20261127.html`: the detailed report, with run settings, engine totals, dimension breakdowns, coverage and the 4-hour timeline.
- `research-data/five-day-results-4h-20261127.txt.gz`: every 4-hour bucket, line by line. Each line carries the bucket, engine, scope, stage or dimension, closes, wins, win rate, profit, loss, net PnL, cost, notional, entries, additions, PF with its state, modeled order actions, and for stage lines the set coverage.
- `research-data/five-day-results-4h-20261127.csv.gz`: the same records as CSV.
- `research-data/five-day-run-20261127.json`: run manifest and settings.
- The full `summary.json` (about 30 MB compressed) is not committed. It was written to `/home/user/sim/out-5d/summary.json` in the session scratch area.

## Reproduce

```sh
node --import tsx scripts/simulation-50.ts --data <market-dir> --output <out> --symbols 30 --warmup 4320 --hours 120 --bucket-hours 4 --workers 4 --documented-default-fees
python3 scripts/render-five-day-report.py <out>/summary.json <report-dir>
```

Market candles are fetched from the public BingX VST endpoint into `<market-dir>`. A completed run is checkpointed per job and can be resumed. The run used source hash `f43e650a…`, from before the performance commit `bd57c7c`. That commit was checked for identical results on two single-symbol jobs (MA_Cross and Break_ATR). Only the ledger header's source hash differs.

## Performance

- Harness: 4 workers, 1,536 MiB heap per worker, 4-hour buckets. Peak worker RSS was 1,063 MiB.
- Wall time for the full run: about 4 h 46 min. Summed job time for one engine was about 19 CPU-hours.
- Engine time is mostly per-lane, per-bar work and is inherent to the model. The harness-side overhead was reduced in `bd57c7c`.
