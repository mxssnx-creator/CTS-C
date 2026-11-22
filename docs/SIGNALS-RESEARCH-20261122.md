# Signals, signed windows and strategy evidence — 22 November 2026

## Implementation

- Real and Exec both accept Short windows through 30. Every selected positive and negative Short and Last outcome has a distinct configuration and parent path. A negative block must still belong to a complete window meeting the configured PF floor.
- Auto PF retains the older calibration history separately from its decision window. In particular, a 250-close Relate window can now use the prior dated closes instead of permanently falling back because the retained window was already full. Histories remain bounded by the selected window, Auto PF history and one same-clock exclusion slot.
- Six optional completed-bar continuation sources were added for the short and medium EMA-cross, RSI-momentum and Donchian states. Each may signal again while its direction remains active and its own Set is flat. They have independent source/configuration identities; none is enabled by default.
- The optional price-distance grid also offers trailing gaps of 3%, 4%, 5%, 6% and 8%, for both dynamic and fixed-distance trailing. Existing selected defaults are unchanged; these choices require their own observed-market validation.
- `scripts/replay-exec-signal-batches.ts` runs a Signals-only scenario one source at a time in separate processes. It preserves each result and an index; it rejects additional Exec profiles that would otherwise be counted repeatedly. It does not merge correlated Set outcomes or claim the resulting grid is a diversified portfolio.

## Observed-market replays

Seven VST contracts—AAVE, AVAX, BCH, ETH, NEAR, SOL and XRP—were read as continuous completed one-minute candles from **14 November 12:55 through 22 November 12:54 UTC**. The main comparison uses three days of prehistory, two days of fit and three days of holdout. Entry and exit use observed candle closes. The assumed round-trip cost is 0.110% of entered notional, including fee-relative slippage; no orders were submitted. Exact candle hashes, per-symbol results, scenarios and aggregate counts are in [the evidence file](../research-data/ctsc-signals-study-20261122.json).

The same scenario was replayed against main commit `ccd815b132d03ffb78c5fd840078ce201e13df57` and the changed code. It selected independent Short 4 and 30 outcomes, including positive/negative Short and Last combinations at Exec. The former code omitted negative Short 30. DCA used two 0.25% steps with 0.5× initial budget each; fixed and fixed-distance trailing exits were included.

| Metric | Previous revision | Changed revision |
| --- | ---: | ---: |
| Fit accepted Exec closes | 0 | 0 |
| Holdout accepted Exec closes | 7 | 7 |
| Holdout accepted return PF | 8.256 | 8.256 |
| Distinct holdout price paths | 7 | 7 |
| Holdout realized peak-to-trough drawdown, modeled cash | 0.00229 | 0.00229 |
| Short-30 Exec Sets / complete windows | 22 / 0 | 44 / 0 |

All seven accepted closes came from NEAR and the existing EMA-cross source. The high PF is a small, concentrated paper sample. The newly available Short-30 alternatives did not mature, so this comparison does **not** establish that they improve profitability or order count. Holdout post-Base, post-Main and post-Real return PFs were 0.892, 1.181 and 1.340 respectively; post-Exec matches the seven accepted closes. The cash drawdown uses the small modeled position budgets and groups closes at the same clock; it excludes open marks and is not an account drawdown. The code retains all observed losses and does not lower the stage thresholds to create trades.

The same matched configuration was also replayed on the existing 50-symbol historical tape from **8 November 02:08 through 12 November 02:07 UTC**, using two days of prehistory and two scored days. There was no separate fit period. The candles had already been examined in previous work, so this is a broader regression comparison, not untouched forward validation. Per-symbol candle hashes, configurations and results for both revisions are in [the 50-symbol evidence file](../research-data/ctsc-signals-50-matched-20261122.json).

| Scored metric | Previous revision | Changed revision |
| --- | ---: | ---: |
| Post-Base Set closes / return PF | 1,645 / 0.703 | 1,645 / 0.703 |
| Post-Main Set closes / return PF | 169 / 0.755 | 169 / 0.755 |
| Post-Real Set closes / return PF | 15 / 4.321 | 15 / 4.321 |
| Accepted Exec closes | 0 | 0 |
| Short-30 Exec Sets / complete windows | 10 / 0 | 20 / 0 |

The added Short-30 paths did not reach a complete window. Set closes may share a price path; they are not independent observations. The post-Base and post-Main results are below one, and there were no accepted Exec closes from which to calculate an executed PF. This study does not demonstrate the requested stable profitability or order volume.

The bounded grid tested three existing short sources and their three continuation variants, TP steps 3/8/12/18, SL-to-TP ratios 0.4/1.2, and fixed, dynamic-trailing and fixed-distance-trailing exits. It used the same seven tapes and time partition. Only the existing EMA-cross source produced accepted holdout trades: the same seven closes above. The other five sources, including all tested continuations, produced no accepted holdout closes. None had accepted fit closes, so no source or new parameter default was promoted.

A separate EMA-cross + DCA run used TP step 12, a 0.4% initial stop and trailing gaps of 2.6%, 3%, 4%, 5%, 6% and 8% under both trailing bases. Its holdout Base return PF was 0.581 over 9,180 Set closes and no Set reached Real or Exec. The wide gaps therefore remain optional rather than promoted as better defaults.

An additional matched strategy study used five days of prehistory and a three-day holdout with the EMA-cross continuation, TP 8/12 and SL/TP 0.5. Normal, Axis, shared Block ratios 0.2 and 0.4, Block Auto at 0.2, DCA multipliers 0.5 and 1.0, and Relate all produced zero accepted Exec closes. Consequently these runs do not establish an executed PF or a winning ratio for any of those arms.

Another paired run compared positive Last at Base/Main/Real against separate positive and negative Last choices at all three stages, using the existing EMA-cross source, TP 12, SL/TP 1.2 and fixed exits. Both variants had zero accepted fit and holdout closes, so the extra paths are verified as independent configurations but have not demonstrated improved execution performance in that cohort.

Some of these dates were examined in earlier project studies. They are regression/research periods, not untouched forward validation. The close-only model does not observe queue position, order-book slippage, funding, liquidation or intrabar margin drawdown. Independent Set copies may share the same underlying price path; the evidence file also records a price-path count.

## Memory and performance

An initial combined grid process was terminated with exit 137 while another local process was running; the available diagnostics did not establish the cause. No result is reported for it. The source-batched run completed all six source groups sequentially; this does not establish a production capacity ceiling. A deterministic test confirms batched and combined stage totals agree for independent Signals sources.

The same synthetic dispatch benchmark was run once on each revision, with no exchange writes. The 500-symbol/100,000-candle catalog workload took 1.73 s before and 1.31 s after. The 50-symbol/20,000-candle active-profile workload took 5.70 s before and 4.87 s after, retained about 13 MiB of additional heap in each run and produced 23,100 modeled Exec closes in each. These single measurements show no observed regression on those fixtures; they are not a latency guarantee or a profitability test.

## x02 demo observation

Two 30-symbol attempts each completed their 72-hour warm-up and observed all 30 symbols for approximately 3.5 and 4.0 minutes before their processes were terminated. A third ended during warm-up. Their journals contained no exchange-order intents or owned lots, and the termination cause was not established. A subsequent reduced run excluded occupied symbols, warmed six symbols with 72 hours of observed history and completed 3.03 minutes of monitoring. Its journal contained no submitted orders, matched fills or owned residuals.

Other positions and protective orders were present on the shared VST account and its inventory changed during the observation; none appears in this test's isolated journal. They were not operated on by the test. With no accepted strategy fill, live-versus-model PF, actual strategy slippage, partial fills and control-order behavior were not measured in this run. HTTP 429 responses were observed during setup and refresh.

Local unit tests, TypeScript and isolated runtime smoke passed. Two final local production build retries were terminated with SIGKILL, and local browser smoke could not start Chromium because the environment rejected a required socket. GitHub Actions subsequently passed the production build, full check, browser smoke and Docker checks on code commit `a9d9804d7b4dd6d955ee69864077c154c4078070`: [independent verification](https://github.com/mxssnx-creator/CTS-C/actions/runs/45028565708), [strategy feature verification](https://github.com/mxssnx-creator/CTS-C/actions/runs/45028565645) and [million-parent-Set capacity](https://github.com/mxssnx-creator/CTS-C/actions/runs/45028565624).

## Research context

- [Liu and Tsyvinski](https://www.nber.org/system/files/working_papers/w24877/w24877.pdf) found cryptocurrency momentum at daily and weekly horizons. That motivates a testable continuation hypothesis, not a claim for one-minute fills.
- [Bysik and Ślepaczuk](https://arxiv.org/abs/2606.00060) study transaction-cost-aware conversion of hourly BTC forecasts to trades. Their selected outcomes are not evidence that these CTS-C indicators have the same performance.
- [Han, Kang and Ryu](https://doi.org/10.1093/rapstu/raag011) show why crypto momentum studies need liquidation and other trading frictions. CTS-C's candle replay does not model those effects.
- [Bailey and coauthors](https://escholarship.org/uc/item/4w1110bb) discuss backtest selection and overfitting. The grid results above are not a statistically independent final validation.
- [BingX's market API reference](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/api-reference.md) documents a per-IP limit for the kline endpoint. Actual x02 observation also encountered HTTP 429 responses; throughput and venue latency must be measured under the target deployment's shared-IP workload.

To replay a bounded source study on matching candle files, use the checked scenario and a new output directory:

```sh
node --import tsx scripts/replay-exec-signal-batches.ts /path/to/tapes /path/to/new-results research-data/ctsc-signals-batch-study-20261122.json 7 1
```

The runner expects one contiguous `<SYMBOL>-USDT.json` array per contract, using the close-time candle shape accepted by `scripts/replay-exec-stages.ts`. It does not fetch or synthesize missing market data.
