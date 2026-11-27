# Stage-gate audit, negative windows and coordination uplift

All runs are paper only. No exchange client is built and no order is submitted. Candles are closed one-minute BingX
VST bars; costs are the modeled 0.11% round trip (0.02% maker, 0.05% taker, 10% fee-relative slippage).

## 1. Does every stage validate its own Last-N and min-PF / Auto-PF gate?

`scripts/audit-stage-gates.ts` recomputes every gate with deliberately naive code (plain loops over newest-first
returns; no prefix sums, no caches) and compares it with the engine:

| Check | What is compared |
| --- | --- |
| Lane windows (Base, Main, Real, Exec) | Published required count, count, floor, PF, `qualified`, `enoughSamples` against a recomputation from the lane's retained returns, at four checkpoints per symbol. A lane flagged `validated` must have passed its own gate and carry exactly one parent proof per earlier stage. |
| Admission proofs | Every distinct proof is re-derived at the instant its position opens, from the live tapes of the lane it names and strictly before its decision clock: window size, the floor (stage minimum, config floor, Auto PF floor from the proof's own history), Auto PF evidence mode and sample count, PF, and `qualified`. Also stage order, ancestor configuration identity, same symbol and side, one decision clock, no repeated lane. |
| Sample independence | A Main, Real or Exec lane's returns are exactly its own closes, newest first. Nothing is borrowed from a sibling. |

Run on 20 symbols, 72 h of prehistory and 24 h scored, all four coordinations, Auto PF `set-history`, Short and Last
windows in **both polarities at every stage**:

| | Checked | Failed |
| --- | ---: | ---: |
| Stage closes with proof structure | 458,436 | 0 |
| Base lane windows | 31,450 | 0 |
| Main lane windows | 377,468 | 0 |
| Real lane windows | 39,852 | 0 |
| Exec lane windows | 48 | 0 |
| Base proofs recomputed | 87,108 | 0 (none skipped) |
| Main proofs recomputed | 6,936 | 0 |
| Real proofs recomputed | 16 | 0 |
| Own-sample independence (lanes) | 417,368 | 0 |

The window grid reaches all four Short/Last polarity combinations at every stage: Base 5,422 to 9,940 lanes per
combination, Main 94,367, Real 9,963, Exec 12. No position was accepted at Exec in this scenario, so a second run
covers Exec and Live with a narrow catalog around the configurations that were accepted at Exec in the 80-symbol run
(Inverse on Micro and Low-Range, CHZ-USDT, same Short/Last polarities, DCA on):

| | Checked | Failed |
| --- | ---: | ---: |
| Stage closes with proof structure | 183,920 | 0 |
| Base / Main / Real / Exec lane windows | 752 / 6,016 / 16,064 / 41,344 | 0 |
| Base proofs recomputed | 79,296 | 0 |
| Main proofs recomputed | 58,272 | 0 |
| Real proofs recomputed | 30,528 | 0 |
| **Exec proofs recomputed** | **5,152** | 0 |
| Own-sample independence (lanes) | 63,424 | 0 |

All four polarity combinations are present at Exec (10,336 lanes each).

```sh
node --import tsx scripts/audit-stage-gates.ts /path/to/tapes audit.json scenario.json 20 [exec|all]
```

The engine already enforces what the audit confirms. Signed windows (negative Short or Last) pass on a net loss of
that block, then the whole window still needs PF at or above the floor. A Short block longer than 12 positions is
positive only, by design.

### Negative windows cost lanes and time

One symbol, 72 h prehistory and 24 h scored, same catalog:

| Window grid | Main lanes | Time |
| --- | ---: | ---: |
| Positive Short, Last both | 1,260 | 0.8 s |
| Both polarities for Short and Last | 5,232 | 2.3 s |
| Both polarities, wider sizes | 52,512 | 10.6 s |

Use [the preset](../research-data/exec-negatives-relate-auto-preset.json) for a bounded grid. Widening the sizes
multiplies Sets faster than it adds information.

## 2. Do Axis, Block, DCA and Relate raise PF? (108 held-out symbol-days)

`scripts/coordination-uplift.ts` runs a fresh engine per symbol and day: 72 h of prehistory, then the next 24 h
scored, rolling forward one day at a time (12 symbols, 9 days). Each coordination is compared with Normal on
identical entries (same configuration, side and entry clock). PF is reported as return-PF (net return per position)
and cash-PF (net P&L), plus a bootstrap interval over days for the cash-PF ratio.

| Stage | Normal cash PF | Axis | Block (ratio to Normal) | DCA (ratio to Normal) | Relate manual |
| --- | ---: | --- | --- | --- | --- |
| Main | 0.67 | allowed 0.64 vs rejected 0.67 | 0.93 to 1.01 | 0.91 to 1.02 | identical (never sized) |
| Real | 0.62 | n/a | 0.94 to 1.04 | 0.92 to 1.02 | identical (never sized) |
| Exec book | 0.55 | n/a | 1.05 to 1.17 (4 of 6 days) | 0.77 to 1.14 | identical (never sized) |

- **No coordination raised cash PF at Main or Real**: every ratio interval there includes 1.0. Normal itself was below
  PF 1 at every stage in these windows (0.55 to 0.67), so there was no edge to amplify. The one interval above 1.0 is
  Block at the Exec book (1.05 to 1.17); it rests on 81 distinct price paths over 6 days and is not evidence of an
  edge.
- **DCA lifts return-PF by about 40%** (9 of 9 days at Main and Real), because a blended entry spreads the same
  trade over more notional. Cash PF does not move, so this is a reporting effect, not extra profit.
- **Axis allowed 3,012 of 281,812 Main entries.** Its filter carried no information: allowed entries had PF 0.64,
  rejected 0.67.
- **Manual Relate never sized above Normal** (0 of 281,812 Main entries): its 60-return gate cannot be met inside a
  day on a Set that starts empty. See [Relate Auto](RELATE-AUTO-20261125.md).

PF is a property of the market and the entry rule. A sizing or filtering coordination can amplify or damp an edge, but
it cannot create one, so none of these should be expected to lift PF when the underlying Sets lose.

## 3. Engine speed

The profile of one full-catalog symbol (7 ranges, 8 TP steps, 3 stops, 3 exits, 22 families, 4 coordinations, 72 h
prehistory, 24 h scored) showed the time in per-candle position marking on very long string keys. Three changes keep
every result identical:

- one set probe per lane per checkpoint instead of one per mark (`markDirty`);
- the "is this lane current" check reads a context cached on the lane instead of three string-keyed map lookups;
- the exit evaluation writes into a reused result object instead of allocating two objects per mark.

| | Before | After |
| --- | ---: | ---: |
| Time | 163.1 s | 116.2 s (29% less) |
| Heap | 785 MiB | 594 MiB |
| Output | | byte-identical apart from time and heap |

## Reproduce

```sh
node --import tsx scripts/audit-stage-gates.ts TAPES audit.json scenario.json 20
node --import tsx scripts/coordination-uplift.ts TAPES uplift.json scenario.json 9 12 3
```

The tapes are `SYMBOL-USDT.json` arrays of closed candles. The uplift scenario adds `warmupMinutes`, `scoreMinutes` and
`stepMinutes` to the replay scenario format. Use a symbol without a corrupt candle (a BTC bar with its open above its
high was excluded from these tapes).
