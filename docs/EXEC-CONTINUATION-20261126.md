# CTS-C Exec and x02 follow-up

26 November 2026

## Stage and execution changes

- Real and Exec expose Short counts of 4, 8, 12, 16, 20, 24, 28 and 30. Every selected Short and Last outcome creates a separate Set for the qualifying parent. The Long option inherits that path's Base count. Full sample coverage and a profitable combined window are required for signed qualification.
- An unresolved venue response gives that intent a one-second retry interval. Another position can advance during the interval. Each position retains its own entry, add and close sequence. Pausing entries keeps submitted intents available for reconciliation.
- The trade stream retains unprocessed ticks between 15 ms work slices. A reconnect invalidates the previous stream generation. An older trade cannot replace a newer readiness mark, and the 250 ms execution timer remains independent of the market-data timers. The runtime paces ticker and kline REST requests separately at 1,050 ms per request based on the published limits. [BingX perpetual market data API](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/api-reference.md)

## Observed price replays

The 48-hour replay used an additional 48 hours of prehistory and the first 20 symbols by filename in the archived [BingX tape](../research-data/ctsc-50-20261111.zip). The wide Inverse grid generated 640 Exec Sets. All fell short of their exact sample count. The aggregate PF of the Base, Main and Real positions forwarded to the next stage was 0.73, 0.90 and 0.78 respectively. There were no accepted Exec closes.

The fresh replay used 10,080 consecutive, closed one-minute BingX VST candles per symbol across 30 symbols. All tapes ended on 26 November at 11:27 UTC. The first two days formed the warmup, and the following five days were scored in consecutive three-day and two-day slices. The configurations came from the previous study. Exec PF uses realized net returns after modeled costs. Cash PF weights gains and losses by actual simulated position size.

| Scenario | First 3d closes | Exec PF | Cash PF | Last 2d closes | Exec PF | Cash PF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Enabled profiles with Trend, RSI, SAR and Breakout | 10 | 0.93 | 0.63 | 3 | 1.89 | 1.41 |
| Inverse RSI turn and SAR, narrow | 4 | 0.24 | 0.12 | 61 | 1.32 | 0.89 |
| Inverse RSI turn and SAR, wide Real and Exec | 4 | 0.24 | 0.12 | 195 | 0.91 | 0.60 |
| Activity ATR momentum | 3 | 0.74 | 0.74 | 2 | 0.00 | 0.00 |
| Six-bar impulse | 3 | 2.76 | 1.38 | 1 | 0.00 | 0.00 |

| Scenario | Post-Base PF | Post-Main PF | Post-Real PF | Post-Exec PF |
| --- | ---: | ---: | ---: | ---: |
| Enabled profiles | 0.84 | 0.85 | 0.96 | 1.89 |
| Narrow Inverse | 0.88 | 0.90 | 0.88 | 1.32 |
| Wide Inverse | 0.88 | 0.90 | 1.09 | 0.91 |
| Activity ATR momentum | 0.72 | 0.79 | 0.94 | 0.00 |
| Six-bar impulse | 0.83 | 0.88 | 0.52 | 0.00 |

Post-stage PF counts closes of positions forwarded to the next stage in the last two days. A qualifying historical PF at entry can be followed by losses after entry. The 195 accepted wide-grid closes represent 39 distinct price paths. Only widths 4, 8 and 12 had complete Exec windows at the end of this run. The release keeps the wide grid and focused profiles available by explicit selection because their cash PF fell below 1.00 in at least one scored slice.

## Runtime verification

In a local workload with 1,000 queued trades and 0.25 ms of work per trade, the longest synchronous drain fell from 252–304 ms to 15–17 ms across four runs. Every queued trade in that workload was processed. These timings cover the local drain and exclude venue acknowledgments. Individual candle evaluation and persistence also use runtime time.

`npm run check` passed with 338 tests, the production build and the runtime smoke test. The shared Last-N test suite and the 50-symbol execution workload also passed. The latter produced 23,100 simulated accepted closes and exact paper Live mirroring.

## x02 demo follow-up

The controlled LINK test confirmed 22 native orders with ten filled market orders and four closed owned lots. Both directions added exactly 20%, resized protection, and reduced the venue position while the independently owned sibling lot stayed protected. The test checked actual trigger prices and quantities against the fills and reconciled signed commissions. All diagnostic orders finished with zero working or partial orders and zero protection gaps. Cumulative partial fills are also covered by regression tests.

Native confirmation took 3.33–4.97 seconds for entries with protection, 6.27–6.73 seconds for additions with protection replacement and 3.68–4.71 seconds for closes. The [earlier 60-minute observation](EXEC-INVERSE-20261122.md#x02-demo-observation) includes the matched procedural Sim/VST fill comparisons.

The 12-minute automated follow-up started at 11:40 UTC after the 30-symbol runtime caught up from 10,080 frozen candles per symbol. Its live scope substituted BTC for the symbol with pre-existing account exposure. All 22 sampled observations had 30 symbols ready. The stream received 63,144 trades by the last running sample, with zero reconnects or overflows. The run recorded zero qualified strategy orders, zero newly accepted paper closes, and zero matched strategy closes. Closing inventory checks confirmed zero owned open positions and orders. The independent account inventory changed during the test and was outside the test's cleanup scope.

The process sampled a peak of 962 MiB RSS with the wide configuration. Event-loop p95 was 29.0 ms. The worst running pause was 5.56 seconds, and the longest sampled age of a quote loop tick during monitoring was 8.61 seconds. The timer's 250 ms dispatch setting describes its target cadence. The controlled order timings above include venue I/O and protection confirmation.

## Reproduction

The configurations are in the [previous study manifest](../research-data/ctsc-inverse-five-day-20261122.json) under `nativeEngineReplays`. The fresh replay used `baseline`, `verified-inverse`, `activity-momentum` and `activity-impulse`. Set each scenario's warmup to 2,880 minutes and scoring split to 4,320 minutes. For the wide Inverse replay, select both Long modes, both Short and Last outcomes, and all eight available Short counts in Real and Exec. The 48-hour replay uses a 5,760-minute tape, 2,880 minutes of warmup and a zero-minute scoring split.

```sh
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/ctsc-replay.json short ordinary 30 3 /tmp/ctsc-scenario.json
```
