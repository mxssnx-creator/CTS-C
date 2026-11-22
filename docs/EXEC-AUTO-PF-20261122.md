# Set-history Auto PF and RSI/SAR replays

## Method

The offline runs used closed one-minute candles from the BingX VST USDT perpetual feed. Both November tapes contain 5,760 consecutive minutes per symbol. The calibration tape runs from November 14 to 18, 2026 UTC. The separate validation tape runs from November 18 to 22 UTC. Each uses the first 48 hours for prehistory and the second 48 hours for scoring. The broader validation includes 15 symbols. BTC was removed from both cohorts after the API repeated a calibration candle with an open above its reported high. Valid price rows were processed unchanged.

The engine settles paper positions on observed closes. Net return includes a 0.11% modeled round trip using two 0.05% taker legs plus 10% fee-relative slippage. PF divides the sum of positive net percentage returns by the magnitude of negative net percentage returns. The scored cohort includes entries opened in the scored window and settled by its end. Exec-book positions are counted separately from entries accepted by Exec and mirrored to Live. Independent configuration copies can share the same symbol, side, entry and exit prices and times. Those copies are counted as separate Set closes and also reported as one distinct price path.

Each stage entry in Exec progression now records the current qualifying parent evidence. Its Auto PF threshold can draw on up to 40 older completed returns from that same Set. It requires 16 such samples, otherwise the threshold falls back to 1.10 while retaining the configured stage floor and every Last-N sample requirement. The tested resumption and checkpoint paths preserve the admission and Exec acceptance proofs. Existing positions continue to settle under their captured rules.

## Observed market results

| Replay | Symbols | Prehistory / scored | Exec-book closes | Accepted Exec closes | Accepted Exec PF |
| --- | ---: | --- | ---: | ---: | ---: |
| Previous branch behavior, calibration | 15 | 48 h / 48 h | 192,686 | 13,244 | 0.4600 |
| Signed Last, independent RSI/Bollinger settings, calibration | 15 | 48 h / 48 h | 50 | 0 | — |
| Mixed indicators and ranges, validation | 15 | 48 h / 48 h | 8 | 0 | — |
| Longer RSI/Bollinger prehistory, validation | 5 | 144 h / 48 h | 214 | 2 | 0.0000 |
| Archived November 7–11 price tapes, validation | 50 | 48 h / 48 h | 0 | 0 | — |
| Thin RSI and Parabolic SAR, calibration | 8 | 48 h / 48 h | 0 | 0 | — |
| Thin RSI and Parabolic SAR, validation | 8 | 48 h / 48 h | 0 | 0 | — |
| Thin RSI and Parabolic SAR, longer prehistory | 6 | 288 h / 48 h | 24 | 0 | — |
| Wider stops and 1m/5m RSI and SAR, longer prehistory | 6 | 288 h / 48 h | 64 | 0 | — |

The old branch row uses the previously evaluated indicator grid and serves as context. Its 13,244 accepted closes represent 2,917 distinct price paths. The signed calibration generated 420 Exec Sets. Every Exec Set remained below its required sample count despite an Exec-book PF of 1.6977. The 15-symbol validation generated 8 Exec Sets and none reached its minimum. The two accepted closes after 144 hours of prehistory came from one NEAR-USDT price path in Normal and DCA. Both settled at a loss. Both matched their Live-paper copies.

The bundled Auto PF presets with fallback floors of 1.05, 1.10 and 1.20 were replayed on AVAX, BCH, NEAR, SOL and XRP. They generated 22, 16 and 8 Exec Sets respectively and zero accepted closes in each run. The 1.10 preset retains the existing stage floor because the trial produced insufficient accepted observations to rank the presets on Executed PF.

## RSI and Parabolic SAR

RSI uses Wilder smoothing with independent 5, 8, 10, 14 and 21-bar periods and thresholds 15/85, 20/80, 25/75, 30/70 and 35/65. Reclaim observes a cross back through an extreme threshold. Momentum observes an onset into an extreme. Parabolic SAR uses step sizes 0.005, 0.01, 0.02, 0.03 and 0.04 and caps 0.10, 0.15, 0.20 and 0.30. Each choice has its own direction state. The exit grid independently specifies initial stops, targets and trailing distances.

The thin study used AVAX, BCH, DOGE, ETH, NEAR, SOL, UNI and XRP. It combined eight indicator choices with TP steps 3, 6 and 8, 0.10% and 0.15% initial stops, 0.05% and 0.10% trailing gaps, and fixed and fixed-distance trailing exits. Each symbol evaluated 144 geometries across Micro and Minimal with independent long and short Sets.

| Family | Validation Base closes / PF | Main closes / PF | Real closes / PF | Accepted Exec closes / PF |
| --- | ---: | ---: | ---: | ---: |
| RSI | 30,224 / 0.4989 | 1,710 / 0.6199 | 226 / 1.5768 | 0 / — |
| Parabolic SAR | 54,365 / 0.4868 | 3,342 / 0.4821 | 92 / 0.4585 | 0 / — |

RSI produced the stronger Real cohort. The 220 Real Sets across both families never reached their full window at the end of the validation, and no position reached Exec in either family during the interval.

The longer prehistory used November 8–20 UTC for AAVE, AVAX, ETH, NEAR, SOL and XRP, followed by the same November 20–22 scored window. The thin profile generated 18 Exec Sets. The 1m/5m profile tested fixed exits with 0.20% and 0.40% stops and generated 54 Exec Sets. The 24 and 64 Exec-book closes were spread across these independent histories. Every Set finished below the required Exec sample count in both profiles.

## Verification and reproduction

The full default window grid on a one-geometry deterministic test produced 4,080 Exec Sets and six accepted closes. A 500-symbol, one-geometry deterministic run processed 47,500 candles in 4.9 seconds with 196 MiB of heap at completion. It produced 6,000 accepted Exec closes, divided equally between long and short. The corresponding Live-paper position counts matched. The historical replay validates Exec and Live paper identities, prices, quantities, costs and net returns before aggregating the scores. The live venue path was outside these paper runs.

Use the exact scenario and candle hashes in [the replay manifest](../research-data/ctsc-auto-pf-20261122.json). Extract a scenario and supply a directory containing the named symbol tapes as JSON arrays of closed candles. The VST tapes use `closedHistory` from `core/history.ts` with `BingxVstClient(null)`. Request chunks of at most 4,320 minutes ending at the manifest's close times, keep timestamps in milliseconds and concatenate in chronological order.

```sh
jq '.oscillators_validation.scenario' research-data/ctsc-auto-pf-20261122.json > /tmp/ctsc-oscillators.json
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/ctsc-oscillator-results.json short ordinary 8 2 /tmp/ctsc-oscillators.json
```

- The standard Wilder calculations follow the [RSI reference](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI) and [Parabolic SAR reference](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/PSAR).
- The port includes the seven [CTS-X RSI momentum configurations](https://github.com/mxssnx-creator/CTS-X/blob/69ad5328299cb9cf2cf555c6adbe233bc0b75da7/docs/tactics.md) and 54 [CTS-A-O Low-Range variants](https://github.com/mxssnx-creator/CTS-A-O/blob/2bc70e22561cccb43336694d43c7deae9f51ea13/src/core/indications/low-range-extra.ts).
- The distinction between observed development rankings and separate validation follows [Bailey et al. on backtest overfitting](https://escholarship.org/uc/item/4w1110bb). The activity-related research sources include the [quarter-hour futures study](https://arxiv.org/abs/2607.09426) and [intraday Bitcoin time-series momentum](https://doi.org/10.1111/fire.12290).
