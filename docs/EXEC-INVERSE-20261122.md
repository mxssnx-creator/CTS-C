# CTS-C Inverse, Activity and five-day Exec replays

Inverse continuation uses the closed-candle direction of the existing inverted source. The first signal can enter at the onset. A still-confirmed state can produce another signal on a later closed candle after its own Set is eligible to reopen. Every indication, side, geometry and path keeps its own Base, Main, Real and Exec evidence. Research vectors and streaming decisions use the same signal rule.

The synchronized market replay supplies the matching closed BTC, ETH and market reference bars before any symbol decides at that clock. Earlier decisions are stable when later reference bars are appended. Complete higher timeframe candles use UTC boundaries. Relaunching from a checkpoint preserves the reference and Set histories.

The Strategy Lab now exposes ten Inverse continuations and ten direct Activity variants. Inverse includes EMA, HMA, RSI, SAR, Bollinger, ADX trend, Donchian, range bursts and a short trend tactic. Activity includes range bursts, ATR momentum, range shifts, a low-ADX RSI fade and price impulses. The optional **Inverse RSI turn and SAR + DCA** execution profile supplies four 1m Minimal and Low-Range geometries. It uses fixed exits, TP step 7 and SL ratio 1.2. **Activity ATR Momentum + DCA** supplies the eight-bar ATR momentum source in 1m Minimal with fixed exits, TP step 8 and SL ratio 0.8. Both profiles use independent Auto PF, Base Long 10/20, signed Short and Last blocks and Exec Short 4/8/12.

## Study design

Each historical run starts from an empty engine and consumes 2,880 observed 1m candles per symbol for prehistory. Each scored window then covers 7,200 minutes on 20 symbols. The cohort includes positions opened and settled during those five days. Dates mark UTC boundaries.

| Window | Feed | Prehistory starts | Scored window |
| --- | --- | --- | --- |
| A | BingX public | Oct 27 | Oct 29–Nov 3 |
| B | BingX public | Nov 4 | Nov 6–11 |
| C | BingX public | Nov 15 | Nov 17–22 |
| D | BingX VST | Nov 8 | Nov 10–15 |
| E | BingX VST | Nov 15 | Nov 17–22 |
| F | BingX public | Oct 20 | Oct 22–27 |

C and E use distinct feeds during the same period. Public data uses BTC. VST uses XLM because the BTC tape contained invalid OHLC values. Each symbol tape contains 10,080 valid, consecutive minute closes. The Inverse configuration was frozen before its scored replay in F.

The modeled cost is 0.110% per round trip. The study uses two taker legs at 0.05% with a 10% fee-relative slippage allowance. Exec PF divides the sums of positive and negative net percentage returns for closed orders admitted at Exec. Cash PF uses the same orders' net cash PnL. The engine also reports the realized PF of each post-stage cohort and counts distinct price paths shared by different qualified Sets. The replay checks all four exact admission proofs and compares the Exec entry, quantity, exit and cost to its Live-paper mirror.

The broad screen covers Normal and DCA, all seven strategy ranges, fixed and trailing exits, paired references, market residuals, technical studies, low-range tactics, Signals and Activity. Screening results guide focused replays in the production engine. These development results reuse periods for comparison. The research replays model costs and leave venue transport, minimum lot sizes and funding to separate measurements.

## Inverse development results

The screens evaluated 464,400 symbol-window configurations, including the 1m, 5m and 15m variations. The production-engine replay of the four-geometry Inverse profile produced these settled results.

| Window | Accepted Exec closes | Distinct paths | Post-Base PF | Post-Main PF | Post-Real PF | Exec PF | Cash PF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 34 | 21 | 0.76 | 1.02 | 1.57 | 1.88 | 1.47 |
| B | 0 | 0 | 0.66 | 0.78 | 0.74 | — | — |
| C | 80 | 46 | 0.91 | 1.03 | 1.08 | 1.60 | 0.99 |
| D | 163 | 67 | 1.14 | 1.50 | 1.55 | 2.82 | 2.18 |
| E | 72 | 42 | 0.90 | 1.03 | 0.93 | 0.96 | 0.66 |
| F, frozen holdout | 17 | 10 | 0.80 | 0.84 | 0.85 | 12.13 | 10.26 |

The table distinguishes the PF of a complete forward cohort from the exact historical PF required for each entry. Cash PF weights realized gains and losses by position size. Window B generated 98 forwarded Real closes distributed across independent Sets and zero accepted Exec closes. This profile is opt-in because its results varied across the observed regimes.

The six windows pooled 366 accepted closes at Exec PF 1.85 and Cash PF 1.30. The 17 closes in the frozen holdout represent ten distinct price paths.

The native coordination matrix used Normal, Axis, Block, DCA and Relate paths. It covered all seven ranges and Exec Short 4, 20 and 30. In C the matrix yielded one accepted close with a loss. D yielded 196 accepted closes at 0.67 Exec PF and 0.65 Cash PF. Each of Short 20 and 30 had 3,618 Sets in C and 7,988 in D. All finished below their required sample count. Deterministic route tests exercise admission when larger windows have sufficient samples.

The second coordination matrix exercised Block rounds, same-stage Axis reference, inherited Long windows and all four trailing modes. It reached 3,978 Real Sets and zero Exec Sets in C.

| Focused candidate in the production engine | Window | Accepted closes | Exec PF | Cash PF |
| --- | --- | ---: | ---: | ---: |
| Break with DCA, Short, TP 12, SL ratio 1.2 | A | 14 | 6.94 | 6.29 |
| VWAP Signals with DCA, Short, TP 12, SL ratio 0.6 | B | 6 | 5.88 | 3.92 |
| Bollinger Bounce with DCA, Minimal, TP 7, SL ratio 1.2 | C | 12 | 1.96 | 1.49 |
| Range burst and ATR momentum with DCA, Minimal and Short | C | 13 | 0.68 | 0.45 |
| Range burst and ATR momentum with DCA, Minimal and Short | E | 22 | 1.23 | 0.66 |
| Eight-bar ATR momentum with DCA, Minimal, TP 8, SL ratio 0.8 | C | 6 | 2.08 | 1.45 |
| Eight-bar ATR momentum with DCA, Minimal, TP 8, SL ratio 0.8 | D | 12 | 2.39 | 1.93 |
| Eight-bar ATR momentum with DCA, Minimal, TP 8, SL ratio 0.8 | E | 21 | 2.80 | 2.52 |
| Synchronized ETH pair and market residual Inverse variants | C | 11 | 0.22 | 0.17 |
| Synchronized ETH pair and market residual Inverse variants | E | 6 | 1.22 | 0.78 |

The result file includes the full set of completed windows for each focused candidate. The Activity momentum profile pooled 39 accepted closes at Exec PF 2.55 and Cash PF 2.11 across C, D and E. A, B and F yielded zero accepted closes for it. The most profitable individual rows have few closes and cover particular markets.

The combined independent cohorts comprise the previously enabled profiles, the four Inverse geometries, the VWAP Signals candidate and the Bollinger Bounce candidate. They pooled 472 accepted closes at Exec PF 1.86 and Cash PF 1.35. Every combined window had a return-based Exec PF above 1.00. Cash PF was 0.92 in C and 0.98 in E.

Adding the eight-bar ATR momentum cohort gives 511 closes at Exec PF 1.92 and Cash PF 1.41. Cash PF exceeds 1.00 in five windows and is 0.97 in C.

Adding the six-bar price impulse with DCA, 1m Minimal, fixed TP step 8 and SL ratio 1.2 gives the following development comparison.

| Window | Accepted closes | Exec PF | Cash PF |
| --- | ---: | ---: | ---: |
| A | 38 | 1.36 | 1.05 |
| B | 12 | 2.07 | 1.23 |
| C | 125 | 1.67 | 1.11 |
| D | 233 | 2.40 | 1.84 |
| E | 146 | 1.43 | 1.01 |
| F | 17 | 12.13 | 10.26 |
| Pooled | 571 | 1.84 | 1.32 |

The six-bar impulse contributed 25 closes in C at Exec PF 2.04 and Cash PF 1.44. It had losses in B and D and Cash PF 0.65 in E. This combined outcome pools independent paper cohorts at their measured sizes. Its candidate selection reused the development windows, and the narrowest observed cash margin was 1.0145 in E.

The deterministic performance workloads processed 100,000 bars on 500 symbols and 252 catalog geometries in 1.17 seconds, retaining 3.44 MiB of JavaScript heap after collection. The active workload processed 20,000 bars on 50 symbols in 4.56 seconds, retained 10.37 MiB and produced 23,100 accepted paper closes with exact Live mirroring.

## x02 demo observation

The authenticated VST run accumulated 60 minutes and 4 seconds with 30 symbols ready. It used seven days of observed VST prehistory and the narrower reference grid for the Inverse pair of sources alongside the existing Exec profiles. The order cap was 25 VST. The runtime resumed the observed history and stage books from the same checkpoint after host terminations. Four ready segments contributed to the hour. The longest lasted 21 minutes and 18 seconds. Missing time during restart, lease expiry and an HTTP 429 cooldown was excluded from the total.

There were zero qualified strategy orders and zero settled accepted paper positions opened during the observation. This left zero naturally matched Sim and VST closes for a strategy PF estimate. The final ledger and venue inventory check confirmed zero remaining owned orders or positions.

A controlled Exec fixture used synthetic qualification history, observed VST entry and exit quotes, and actual VST market and protection orders. Both the DOGE long and the TRX short matched their simulated closes. Actual return was lower by 0.0264 and 0.0031 percentage points respectively. Venue fees were about 0.010 percentage points below the modeled cost on each fill pair. The venue minimum lot size made the real sizes 10.18× and 10.68× their modeled sizes. Both cases settled with zero residual orders or positions.

The isolated mechanics test checked long and short positions on LINK. It confirmed 22 native orders and ten filled market orders. Each direction added exactly 20%, then closed the 2.4-unit lot while preserving the other 2-unit lot and its two protection orders. It verified each native quantity and trigger price against the filled lot's actual average price, including protection replacement after the add. The venue filled orders in full during these cases. Tests exercise cumulative partial fills and residual close reconciliation.

The dispatch cadence was 250 ms. The final segment's event-loop p95 was 35.5 ms, and peak RSS was 392 MiB. The maximum recorded event-loop pause was 15.6 seconds. Procedural entry receipts with protection took 2.70–3.55 seconds. Add and protection replacement took 4.18–4.20 seconds, and close confirmation took 2.85–2.95 seconds.

## Reproduction

The [result manifest](../research-data/ctsc-inverse-five-day-20261122.json) stores source tape digests, knobs, stage cohorts and x02 evidence. Prepare the named contiguous 1m candle arrays using the BingX market history and run the desired scenario from an empty engine.

```sh
jq '.nativeEngineReplays["verified-inverse"].scenario' research-data/ctsc-inverse-five-day-20261122.json > /tmp/ctsc-inverse.json
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/ctsc-inverse-results.json short ordinary 20 1 /tmp/ctsc-inverse.json
```

Use the x02 harness with a frozen VST tape manifest and the selected [demo settings](../research-data/ctsc-inverse-five-day-20261122.json). The harness checks the tape hashes and chooses 30 symbols that have no existing demo inventory.

```sh
jq '.vst.scenario' research-data/ctsc-inverse-five-day-20261122.json > /tmp/ctsc-vst.json
node --env-file=/path/to/x02.env --import tsx scripts/x02-quality-test.ts --execute --symbols 30 --minutes 60 --history 10080 --data /path/to/frozen-vst --settings /tmp/ctsc-vst.json --output /path/to/fresh-journal
```

## References

- BingX publishes the [perpetual market API](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/api-reference.md) and [order API](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md).
- Intraday study hypotheses come from [Wen et al. on momentum and reversal](https://doi.org/10.1016/j.najef.2022.101733) and [Bitcoin time-series momentum](https://doi.org/10.1111/fire.12290).
- Relative-price methods and repeated parameter comparisons are informed by [Gatev et al.](https://doi.org/10.1093/rfs/hhj020) and [Bailey et al.](https://escholarship.org/uc/item/4w1110bb).
