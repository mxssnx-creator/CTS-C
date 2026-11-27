# Relate: loss series, win run and Relate Auto

Relate changes only the **size** of the next order of one specific relation, meaning one Set's consecutive positions
(symbol, configuration, side, stage). Entries, exits and the per-position return of every trade stay identical to
Normal, so return-PF cannot change. Only the cash result and the drawdown move. It is off by default.

## The two types

| Type (`relateStepMode`) | Rule |
| --- | --- |
| **Loss series** (`loss`, default) | Every losing order raises the next order of the relation by the volume factor **X** (`relateRatio`), until a win ends the series, for at most **N** rounds (`relateSteps`). A series that loses all N rounds is over and the next order restarts at base. Never above `relateMaxMultiplier`. |
| **Win run** (`wins`) | The same ladder climbed on consecutive winning orders, at most N steps. A loss returns the next order to base. This is the original behavior, and a checkpoint without a step mode keeps it. |

The defaults are N = 5, X = 0.2 and a cap of 2: a loss series sizes the orders 1.0, 1.2, 1.4, 1.6, 1.8, 2.0 times base
and, if the sixth order also loses, starts again at 1.0. With X = 0.4, N = 4 and a cap of 2.6 the orders are 1.0, 1.4, 1.8,
2.2, 2.6. Order notional is capped separately by `maxOrderNotional`.

## When a relation may be raised

Volume is raised only while the relation's own recent returns qualify, so a relation that has stopped working is never
averaged into. Two gates:

- **Manual**: the Set's own 60 to 250 returns have PF above the larger of `relateMinPF`, the configuration floor and the
  Auto PF floor, and the stop sits within `relateMaxSlRatio` (at most 0.5) of the target. This is rarely met inside a
  day, because a Main, Real or Exec Set starts with an empty book. The default stop ratios 0.6, 1.0 and 1.4 can
  never pass the stop cap.
- **Relate Auto** (`relateAutoEnabled`): the newest `relateAutoLastN` returns (default 30), once at least
  `relateAutoMinSamples` exist (default 8), must have PF above the larger of `relateAutoMinPF` (1.1), the configuration
  floor and the Auto PF floor, and a positive mean at least `relateAutoConfidence` standard errors above zero (1.64,
  95% one-sided). With `relateAutoInherit` a short own tape is extended by older returns of the same trade stream held
  by the ancestor Sets, counting only closes before the descendant's first entry, so nothing is counted twice and
  nothing is borrowed from a sibling. Auto applies to every relation, including the default stop ratios and exit modes
  other than trailing-only.

The gate is the part that protects the account. Relate adds exposure, so a false activation costs real money; the
defaults (12 returns, 2.33 standard errors, 99% one-sided) were chosen from the sweep below because they raise the fewest
orders on noise.

## Settings

| Key | Meaning | Range |
| --- | --- | --- |
| `relateEnabled` | Create Relate relations | on/off |
| `relateStepMode` | `loss` series or `wins` run | |
| `relateSteps` | N, most rounds or steps | 2 to 15 |
| `relateRatio` | X, volume added per step as a fraction of base | 0.2 to 6 in 0.2 steps |
| `relateMaxMultiplier` | Cap on the multiplier | 1 to 8 |
| `relateAutoEnabled` | Use the Auto gate | on/off |
| `relateAutoLastN`, `relateAutoMinSamples`, `relateAutoMinPF`, `relateAutoConfidence`, `relateAutoInherit` | Auto gate | 3 to 100, 3 to 100, 1.01 to 10, 0 to 3, on/off |
| `relateLastN`, `relateMinTrades`, `relateMinPF`, `relateMaxSlRatio` | Manual gate | |

Enabling Relate or changing any of these starts a new cohort of Relate Sets, like the other coordinations. The
importable preset `research-data/exec-negatives-relate-auto-preset.json` turns on a loss series with Relate Auto.

## What the evidence says

### Market data, where the Sets themselves lose

`scripts/relate-sweep.ts` records each relation's trades once at base size and re-prices them under 128 variants
(both types, N = 2, 3, 4, 6, X = 0.2, 0.4, 0.6, 1.0, four gates) with the engine's own `relateAllocation`. A check on
two symbol-days confirms the offline price equals a real engine run with the same policy to the last digit, and a
test keeps it that way. Variants are fitted on days 1 to 5 of 12 symbols (60 symbol-days), then judged on days 6 to 9
of the same symbols (48) and on 80 other symbols (1 day each). Each run has 72 h of prehistory and 24 h scored, the
default stop ratios 0.6, 1.0 and 1.4, Micro and Short ranges, and all four coordinations.

Without Relate, net P&L was **-97.5** (fit), **-119.3** (validation) and **-168.6** (80 other symbols), with Real PF
0.54, 0.77 and 0.50. The table gives the change from that baseline for N = 4, X = 0.4 (negative is worse; 0 would be no effect):

| Type | Gate (returns / standard errors) | Orders raised | Validation | 80 other symbols |
| --- | --- | ---: | ---: | ---: |
| Loss series | **12 / 2.33 (default)** | 0.3% | -0.25 | -0.09 |
| | 8 / 1.64 | 2.7% | -1.82 | -1.92 |
| | 6 / 1.0 | 12.9% | -12.63 | -6.14 |
| | none | 32.2% | -16.48 | -29.78 |
| Win run | 12 / 2.33 | 1.3% | -7.87 | -2.82 |
| | 8 / 1.64 | 7.7% | -27.04 | -11.11 |
| | 6 / 1.0 | 23.1% | -50.87 | -35.66 |
| | none | 30.4% | -26.90 | -33.47 |

- **No variant beat no Relate.** Of the 128, none was positive on the fit days, none on the validation days and none on
  the 80 other symbols, so the fit stage selected nothing. Relate cannot create an edge; where the Sets lose it can
  only add to the loss.
- **The evidence gate is what limits the damage.** With no gate the loss series raises a third of all orders and costs
  14% of the baseline loss on validation, and it raises drawdown by 10% to 20% (mean drawdown 3.40 against 2.95 on fit,
  worst 8.53 against 7.22). The 99% gate gives up 98% of that cost.
- **The loss series costs far less than the win run** where the Sets lose, because the win run raises most orders.

### A genuine edge (synthetic trending series with losses)

Trend entries on a seeded series with positive drift and noise (four series, PF 3 to 13), 3,000 candles, default gate:

| Series | Normal net | Loss series | Win run |
| --- | ---: | ---: | ---: |
| seed 3 (126 orders, 35 losses) | 0.1082 | 0.1112 (+2.7%) | 0.1795 (+65.8%) |
| seed 7 (116, 20) | 0.1434 | 0.1452 (+1.3%) | 0.2403 (+67.6%) |
| seed 5 (148, 15) | 0.2893 | 0.2929 (+1.2%) | 0.4986 (+72.4%) |
| seed 11 (116, 16) | 0.1459 | 0.1467 (+0.6%) | 0.2679 (+83.6%) |

With a real edge the win run nearly reaches the 2x cap on most orders, while the loss series only raises the order after
a loss, which is rare. Entries and per-position returns are identical to Normal in every case.

### What to do with this

Leave Relate off while the Sets lose, which is the case in all the market data here. Turn it on only for Sets whose own
returns show an edge; the gate encodes that. The win run pays when the edge is real and costs the most when it is not;
the loss series is the cautious type. If you want the loss series anyway, keep the default gate: loosening it is what
costs money.


## Reproduce

```sh
node --import tsx scripts/relate-sweep.ts DAYS_DIR DAYS_SCENARIO WIDE_DIR WIDE_SCENARIO result.json [days] [symbols] [workers]
```

The harness records each relation's trade sequence once at neutral volume and the ancestor tape inherited at every
entry, then re-prices every variant offline with the engine's own `relateAllocation`. Variants are fitted on the early
days and judged on later days of the same symbols and on other symbols.
