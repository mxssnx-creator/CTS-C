# Market tape identity — 12 November 2026

Visual review of PR #21's successful hosted screenshots exposed repeated quote panels after view/settings/connection interactions. The market tape and conditional StrategyLab were siblings with the same connection-only React key. Give each component its own stable role plus connection key, preserving connection resets while preventing sibling reconciliation collisions.

The existing full browser sequence now asserts exactly one quote panel both initially and after the complete interaction sequence. Duplicate-key console warnings also fail verification. Production browser screenshots must demonstrate the corrected result before merge. This change affects presentation identity only; strategy, exchange and economic behavior retain PR #21's verified source. It adds no live PF or post-Base market validation evidence.

The same integration retains pending PR #22's original history: ownership is checked between individual history candles, and the bounded study reads lightweight stream counters between minute-stamped full stage observations. Existing execution comparisons and namespaced logical-intent recovery from #21 remain present. TypeScript and all 29 combined runtime/restore/policy checks pass locally; full hosted verification runs on the combined source.
