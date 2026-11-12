# Stable logistics and regression contracts

These are implementation contracts, not a guarantee of profitable future trading. Keep this document and the named tests together when changing the engine.

## Identity and evidence

One lane is identified by connection, symbol, exact economic configuration, direction, coordination, stage and evaluation/sizing cohort. Source ID, completed-bar timeframe, exit geometry, fees, hold policy and Signals risk cap contribute to configuration identity. Last-N/block policies and relational sizing contribute to cohort identity. Changing a factor retires the old cohort; its positions retain captured economics, exits, fills and historical losses.

| Boundary | Required behavior | Regression evidence |
| --- | --- | --- |
| Source → configuration | Calculate once per unique symbol/source/timeframe; never reuse a sibling source's result. Distances do not change the indicator's lookback. | `ported-integration`, `ported-indications`, `signals-contracts`, `technical-signals` |
| Base → Main | Require that direction/configuration/coordination's own completed Base outcomes and PF/risk floor. | `admitted-pf`, `processed-stages`, `progression-integrity` |
| Main → Real | Create a new Main evidence ledger; no copying sibling trades or prefilling new stage samples. | `processed-stages`, `incremental-checkpoint` |
| Real → Live | A current passing Real lane gates a fresh entry. In Real-mirror mode copy that exact admitted entry allocation and parent position ID. | `live-mirror`, `processed-stages`, independent ledger audit |
| Stage → venue | Recheck ownership, current qualification and position state immediately before each financial write. A closed/stale/retired candidate cannot become a new exchange order. | `runtime-policy`, `executor`, `runtime-loop` |
| Venue → accounting | Attribute fills to exact owned native order IDs. Apply cumulative quantity deltas once and signed commissions once. Unknown is never an empty inventory or a zero fee. | `bingx`, `executor`, accounting mutation tests |

The legacy `continuous-ancestors` mode rechecks every ancestor. `processed-sets` captures a valid immutable parent lineage when a derived stage starts, then progresses its own samples. Later Base changes do not erase that lineage, but current Real evidence still gates Live. These policies must be labeled separately in research. Warmup cannot submit exchange entries; no future candle may initialize a training gate.

Last-N is based on completed positions, never elapsed hours. Optional disjoint blocks use newest minimal outcomes, then the preceding short block, then the preceding long block. Windows do not overlap, borrow samples or silently clip their requested lengths. Negative short/minimal polarity is an independent condition; the long window still requires positive net PF. Each engine has an explicit selected policy per stage, with policy identity in derived cohorts. Hourly report rows are observations, not additional entry gates.

## Coordination and controls

Normal, Axis, Block and DCA have separate directional lanes and stage histories. Disabling funded Normal keeps internal Normal reference calculations for additional strategies; those references cannot create counted Native/Live Normal executions. Trailing switches apply independently and must not loosen an already captured stop. Entry candles cannot close themselves using an assumed intrabar path. Genuine later trades in that millisecond are separately ordered observations.

Block recovery rounds contain the configured number of completed positions, retain unrecovered net losses, bound the next block's increase, and pause full rounds after recovery. Real-mirror Live must not run a second divergent recovery budget. DCA/Block additions use the accepted exchange entry-size scale, preserve the requested ratio and reject unplaceable quantities before canceling protection. Relational type/source/strategy/range/symbol factors apply once to entry budget, with neutral defaults; they do not multiply return PF.

Signals offers 103 inherited computational source families, two parameter variants each, and 225 independently identified category/minimum-count/input-mask/dominance bands. One source contributes one vote; conflicting enabled variants abstain. Bands 60–65%, 65–70%, 70–75%, 75–80% and 80–100% are disjoint. Quiet sources do not dilute the active vote denominator; minimum active-source count remains mandatory.

An optional Signals gate caps peak-to-trough **cumulative net-return percentage points**, calculated chronologically within that lane's own evidence window. It is not account drawdown, leverage-adjusted risk or a promised future loss limit. Its value changes configuration identity and is captured in admission proofs. PF/sample gates still apply independently.

## Own orders, leverage and manual exchange closes

Each journal atomically creates a durable random execution namespace. New wire client-order IDs include it, so identical signals from separate journals do not share order identities. Existing logical intents retain their stored legacy wire IDs across upgrades and restart. Conditional orders are tracked by their returned native IDs; a lost conditional reply is not permission to resubmit or adopt a nearby foreign order.

Before any entry/add, verify hedge mode, actual inventory, precise quantity/tick minimums and order-notional cap. Maximum leverage is mandatory by default: query the authenticated symbol/direction tier, set `side=LONG` or `SHORT` if needed, and confirm the current maximum. No `BOTH` or account-mode mutation is used. Inventory checks precede leverage changes so foreign exposure is not altered. Maximum leverage changes required margin, not notional-return PF or the requested volume ratio. Private I/O latency is measured separately from scheduler targets.

An externally flattened side requires two successful flat observations at least one second apart, at least ten seconds after the last owned fill, and no unresolved opening/closing order. Tombstone its owned positions, cancel only their known brackets, and retain unavailable external price/fee accounting. Do not infer or attribute a manual fill from a different user's order. Partial/ambiguous discrepancies remain isolated for that symbol/direction; other lanes keep calculating. A tombstoned position or settled intent cannot reopen, including after restart. Later distinct position IDs may trade once inventory and cleanup are confirmed.

## Comparisons and display

Match exchange and simulated closes by exact connection/position/lane identity. Show open, awaiting-model and incomplete-accounting records separately. Compare normalized net returns on the same complete qualified cohort; do not compare a selected simulated subset against all exchange trades. Keep all owned exchange PF separately visible. Show actual/model quantity ratio, fee difference, entry-price difference and net-return difference, and scale expected cash to actual entry notional. Missing comparison data cannot be interpreted as a zero difference or a successful calibration.

Fees in exchange results come from actual signed fills. The close-price simulator models its declared entry-notional round-trip cost and fee-relative slippage once. Native fill prices already include execution effects, so do not subtract simulated slippage again. Funding is excluded from these owned-fill metrics and must remain labeled. At least eight complete pairs is a display readiness threshold, not statistical confidence or permission to choose an optimal minimum distance from the same evaluation period.

Overview and trade history expose the same comparison data; JSON export retains records and source labels. Current validated-window PF, all admitted subsequent paper PF and actual exchange PF are distinct measures. Zero closed outcomes displays unavailable PF. Closed correlated paper lanes do not constitute an exchange portfolio or independent statistical samples.

## Performance and recovery

Source history is bounded at 4,320 closed bars per symbol/timeframe and rebased in blocks. A 10-second lane consumes actual contiguous recorded trades; minute history cannot manufacture sub-minute evidence. Stream caches must agree with causal historical vectors, prefixes, rebases and serialized restart. Gate/Axis/risk windows reuse unchanged own samples. Fill reconciliation uses per-lot indexes, and unchanged accounting does not rewrite the complete lot book. Execution timing retains at most 128 cycle samples; comparison responses cap detail rows while retaining complete aggregate denominators.

SQLite checkpoint reads are one consistent snapshot. Reuse unchanged hydration; changed revisions hydrate outside execution ownership and are checked under the new fence. Guard every exchange write. An expired owner stops rather than extending its authority. A 100 ms scheduled wake-up is not a claim of 100 ms exchange fills, reconciliation or full-cycle completion.

Run `npm run check`, the browser tests, `npm run test:lastn-blocks`, and the Python accounting tests before merge. Preserve the exact historical six-symbol regression and the failed broader 50-symbol studies; do not revise historical losses to meet a performance target. New configurations require chronological forward tests, source/data provenance and explicit sample coverage before promotion.
