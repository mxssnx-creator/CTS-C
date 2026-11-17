# DCA step evaluation

The Strategy Lab exposes a DCA Auto switch, recent observation count, minimum observations and minimum add PF. Each stage, symbol, direction and configuration owns its step history. An insufficient or unknown history holds the step. A hold prevents deeper additions to that position, while observed adverse levels continue to build their separate histories. Each observed step uses its trigger price and the parent's eventual modeled exit, net of the captured round-trip cost. This measures the add conditional on the parent's exit. It cannot estimate the exit of a counterfactual position whose DCA fills would have changed its stop or target.

The Real stage decides additions for its mirrored Live position. The position ID, timestamp and price must match. A settings edit starts a new economic cohort when Auto is enabled. The stopped or held cohort can still close under its existing protection and complete its own observations. Saved manual lane identities are preserved when Auto is off.

The default remains manual. This repository includes the offline replay command:

```sh
node --import tsx scripts/replay-dca-auto.ts /path/to/recorded-candles /path/to/result.json
```

Four symbols, Trend and Signals Micro, 48 hours of prehistory and a 12-hour forward segment per run. Costs used a 0.11% modeled round trip. Live here means the simulated Real mirror.

| Day (UTC) | Policy | Entries | Closed | Adds | Return PF | Money PF |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Oct 5 | All four | 0 | 0 | 0 | unavailable | unavailable |
| Oct 9 | Manual 1% | 99 | 99 | 0 | 0.039 | 0.039 |
| Oct 9 | Manual 0.15% | 262 | 254 | 200 | 0.157 | 0.098 |
| Oct 9 | Auto 30/15 | 99 | 99 | 0 | 0.039 | 0.039 |
| Oct 9 | Auto 8/5 | 108 | 108 | 3 | 0.039 | 0.036 |
| Oct 13 | Manual 1% | 527 | 518 | 0 | 0.693 | 0.693 |
| Oct 13 | Manual 0.15% | 1,175 | 1,164 | 459 | 1.459 | 0.985 |
| Oct 13 | Auto 30/15 | 528 | 519 | 9 | 0.706 | 0.681 |
| Oct 13 | Auto 8/5 | 585 | 574 | 80 | 0.861 | 0.794 |

The replay emitted zero order intents and all active arms had negative monetary P&L in both periods with trades. Drawdown in the JSON reflects realized model P&L. The windows had been used in earlier research and do not constitute an untouched holdout.
