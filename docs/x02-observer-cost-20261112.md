# Bounded history slices and study telemetry

The broad twelve-symbol native study still failed ownership recovery under load and warmed only three symbols; it produced no owned executions. Its aborted result is retained. The checkpoint guards deliberately refuse an expired lease; a stale writer is never silently revived.

Native history recovery now checks ownership between individual candles, rather than hiding up to eight expensive candles inside one work-budget check. A regression injects a costly candle and verifies the next candle remains queued for a later slice. Both cold recovery and an already-ready symbol retain their existing admission rules.

The bounded study runner reads stream counters without constructing a complete dashboard snapshot on every five-second observation. It records full stage statistics once per minute with their own timestamp. This changes monitoring cost, not strategy gates, historical observations, exchange accounting or the interval requested after warmup. A resumed study must report its actual readiness and cleanup separately; no positive execution PF is inferred from an empty sample.
