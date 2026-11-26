# CTS-C stage and checkpoint performance

26 November 2026

Base checks the smallest usable window before creating Set configurations. It creates a configuration when the corresponding policy qualifies. Main, Real and Exec continue from their exact parent receipts. A result can be reused when the immutable closes, disjoint policy, PF settings and dated sample count match. Every lane still owns its closes and admission proof.

The dashboard calculates stage and coordination totals in one pass. Its bounded view reuses totals between changes to positions, samples, lineage and settings. Position marks and intent status are read from current state. The recent close history overwrites its oldest entry in place and keeps its newest-first API and checkpoint order.

Runtime checkpoints write changed lane rows as compressed binary. The v5 metadata references a separately compressed, checksummed configuration index. SQLite skips writes when that index, a lane row or the settings record is unchanged. Legacy checkpoints remain readable and their untouched rows can coexist with upgraded rows. The read-only checkpoint audit uses the production loader. A downgrade to an earlier binary uses a backup from before the first v5 save.

Observed trade bars are recorded in one transaction per batch, with separate retention per symbol. Stage evaluation begins after that transaction commits. The runtime keeps a failed batch for retry and yields between processing slices. SQLite uses full synchronous durability. A 16 MiB journal size limit applies when SQLite can reset the WAL. [SQLite journal sizing](https://sqlite.org/pragma.html#pragma_journal_size_limit)

## Measurements

Baseline `ead92fa` and the optimized build used the same Node 24 workspace, settings and price tapes. The dashboard used the saved x02 checkpoint with about 108,000 Sets. CPU times are from the process itself because background load varied. The replay numbers use the median of two runs per build for 10,080 ZEC candles and 205,344 closes. The disk measurement uses a fresh checkpoint of the three-symbol wide replay with 67,190 lane rows after a WAL checkpoint.

| Workload | Baseline | Optimized |
| --- | ---: | ---: |
| ZEC replay, process CPU | 11.77 s | 10.29 s |
| ZEC replay, retained V8 heap after collection | 85.1 MiB | 85.1 MiB |
| First dashboard read, process CPU | 3.10 s | 1.84 s |
| Repeated dashboard read on unchanged stage books, median process CPU | 1,379 ms | 12.5 ms |
| Restore the saved x02 checkpoint, process CPU | 28.37 s | 23.86 s |
| Persist 450 synthetic market bars, process CPU | 107.5 ms | 10.6 ms |
| Fresh SQLite checkpoint | 145.2 MiB | 79.7 MiB |

The dashboard bytes used for the comparison had identical hashes. Repeated reads measure an unchanged stage book. A relevant book change rebuilds the shared view once. The storage timing covers persistence itself and excludes market or order latency.

The separate capacity fixture materialized and restored 24,108 current Sets. Its one-million target provides a projection. The layout test compares live SQLite pages for the same rows in the production binary layout and its base64 predecessor. It also reports two alternative table layouts. On the 67,190 replay rows, a normalized integer-key layout saved 16 KiB relative to the binary rowid layout. The rowid layout can upgrade rows during ordinary checkpoints without rebuilding the lane table.

## Trade replay parity

Both Inverse profiles ran against the same 30 observed VST tapes with 2,880 minutes of prehistory and 7,200 scored minutes. All per-symbol financial and stage outputs, including post-stage figures, complete windows, accepted Exec cohorts and unique paths, matched the baseline exactly. The table shows the final 2,880-minute holdout. [Replay inputs and configuration](EXEC-CONTINUATION-20261126.md#reproduction)

| Inverse configuration | Accepted Exec closes | Exec PF | Cash PF |
| --- | ---: | ---: | ---: |
| Narrow | 61 | 1.3213 | 0.8877 |
| Wide | 195 | 0.9105 | 0.5981 |

The work verifies performance and financial parity with the previous release. The trade tests are paper replays. x02 in this report refers to the saved operating checkpoint used for the dashboard and restore measurements.
