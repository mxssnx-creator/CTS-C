# Engine v4: qualification, Trend/Break and execution

The result to assess is the net outcome **after** a configuration was admitted, followed by actual closed exchange lots. A high PF in a selected Base window does not establish either result.

| Metric | Scope |
| --- | --- |
| Validated window PF | Current last-N windows of current configurations meeting their own and ancestor gates. A selection statistic. |
| Admitted forward PF | Every subsequent closed outcome carrying immutable own-parent admission proof, including later losses and retired cohorts. |
| Lifetime PF | All recorded outcomes, including older checkpoints without admission proof. |
| Validated execution PF | Complete closed owned exchange lots originating from engine admission proof. |
| All owned execution PF | Complete closed owned lots, including separately labeled lifecycle diagnostics. |

Paper PF normalizes net outcome by filled entry notional. Exchange PF normalizes actual reconciled net P&L by total actual opening notional, not current remaining quantity. Fees are applied once; funding is excluded. Open lots and incomplete accounting are reported separately. No-loss samples display their state instead of a fabricated finite estimate.

Each Main, Real and Live paper entry captures the preceding stages' lane IDs, sample counts, N, PF, threshold, and check time. Each stage still learns from its own subsequent positions. A current winner filter never erases a later losing execution. Older checkpoints remain usable but their missing proof is disclosed.

## Additional indications

The original eight available calculations remain selectable. The four original core defaults still produce 252 configurations per symbol with the balanced grid.

| Family | Calculation / relation |
| --- | --- |
| Trend | Fast/slow EMA alignment, slow slope and close confirmation. |
| Trend ADX | Trend alignment plus Wilder-smoothed directional movement and ADX. |
| Trend Efficiency | Trend alignment plus path efficiency. |
| Trend Fade | Volatility-normalized EMA stretch followed by three completed reversal closes; adapted from CTS-G. |
| Break | Close beyond the preceding high/low channel, confirmed by EMA direction. |
| Break ATR | Fresh cross of the preceding EMA ± 2 preceding ATR. |
| Break Volume | Channel breakout plus volume above 1.5 times preceding mean volume. Missing volume cannot confirm it. |
| Break Retest | A preceding breakout, followed on a later bar by a level retest and closing confirmation. |
| Break Reversal | Fresh channel break against a large preceding context move, normalized by preceding return volatility; adapted from CTS-G. |

Periods 10/14/20/40/60 and timeframes 1/5/15/30 minutes are independent catalog axes for these families. The other indications keep their original periods and calculations. Higher timeframes require complete contiguous UTC source minutes; partial/gapped frames cannot fire. The replay UI requires 1m source candles when these grids are selected. Entries and exits fill at observed prices; candle highs/lows never supply an invented fill price.

Each family, period, timeframe, TP step, SL ratio, exit mode, symbol, direction, coordination and stage has its own economic identity. All six ranges and fixed/trailing/trailing-only exits remain available. A causal signal trace is reused across different distance/exit candidates during research; an independent replay parity test verifies that this changes no trade.

Live signal updates fetch exchange completed OHLCV. Quote ticks manage positions and do not manufacture volume. Historical recovery is non-executable; only a fresh incremental completed minute can create entry intents.

## Axis and Block

Axis uses disjoint previous and recent windows from the matching Normal configuration and direction. Its reference may be the matching stage or continuous Base history. Neither reference supplies Axis's own Main/Real results. Existing defaults keep the matching-stage rule.

Block Shared divides one budget across entry and favorable additions. Additive uses the initial budget plus fixed-size additions. Ratios are applied to the captured budget, not compounded against its growing balance. A confirmed trail stays active and its stop never loosens when an add changes weighted entry.

The exchange executor captures one actual entry quantity scale and uses it for subsequent additions. Entry normalization accounts for the smallest planned relative leg. A partially filled entry updates its scale from actual fills; an impossible sub-minimum addition is rejected before protection is canceled. A per-order notional cap also applies before protective cancellation. Protection and closes use only journaled native IDs and actual owned quantities. Tiny floating subtraction noise is clamped consistently with the ownership tolerance.

## Settings and connections

The form, JSON imports and server saves share one strict editable schema. TP, SL, trail, hold and coordination budget factors are bounded and have separate meanings. Failed saves do not mutate the engine. New economics create new lanes; open positions retain their recorded exits and sizing.

x02 and x01 have fixed VST/mainnet hosts, dedicated credential names and separate stores, settings, leases, journals and runtime controls. Connection selection propagates through snapshot, save, replay and export. An executor rejects a foreign-account intent. Merely opening x01 does not start it.

## Research and verification

The fixed seven-day study uses six symbols, 60,480 observed candles, per-symbol x02 commissions and fee-relative slippage. Configurations are ranked on the first 65% only; the remaining 35% retains every selected loss. Own-stage gates are exercised in the actual engine. Correlated lane-return sums are not account equity.

The paired Axis/Block study freezes the prior core training selection, compares matched entries with controls using the same observed prices and costs, and reports filled-notional PF and equal-reserved-budget PF separately. Unfinished pairs are counted. Reusing this period for further research makes it retrospective regression evidence, not untouched future profitability evidence.

Tests cover all new families, periods/timeframes, exits, complete catalog dimensions, causal prefixes, serialization, replay/engine parity, stage independence, admission provenance, future/held-out separation, strict settings, account isolation, partial fills, native protection, idempotency, fee reconciliation, ratio scaling and execution PF. CI also exercises the actual browser UI and Docker lifecycle with isolated synthetic fixtures and no exchange writes.

The x02 0.2-ratio live lifecycle diagnostic confirmed 10-unit entries and 2-unit additions in both directions, native protection replacement, exact owned closes, zero residual orders/positions and equality with starting inventory. This verifies mechanics, not profitable strategy execution. A separate x01 read-only check verified credentials, USDT balance response and hedge mode without placing orders.

## Method references

- [CTS-G indication engine](https://github.com/mxssnx-creator/CTS-G/blob/main/server/pulse/indication_engine.py): trend fade and reversal break adaptations.
- [CTS-A-O timeframe research](https://github.com/mxssnx-creator/CTS-A-O/blob/main/docs/indications-mtf.md): completed-bar relations and out-of-time comparisons; its results are not imported as CTS-C performance.
- [Donchian Channels](https://www.tradingview.com/support/solutions/43000502253-donchian-channels-dc/): high/low channel definitions.
- [Average True Range](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/): true-range volatility calculation.
- [Directional Movement](https://www.tradingview.com/support/solutions/43000502250-directional-movement-dmi/): directional movement and trend strength.
- [Keltner Channels](https://www.tradingview.com/support/solutions/43000502266-keltner-channels-kc/): moving-average and ATR envelopes.
- [Time Series Momentum](https://fairmodel.econ.yale.edu/ec439/mosk.pdf): evidence at substantially longer horizons; no implied proof for minute crypto trading.
- [Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf): why repeated parameter search is insufficient evidence of future profitability.
