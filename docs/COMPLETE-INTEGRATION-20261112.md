# Pending Signals and execution integration — 12 November 2026

The unpublished Signals implementation is applied to current main, preserving the merged observed-history lease renewal and explicit study symbols. It adds 206 source variants and 225 disjoint voting coordinators, independent source/range/timeframe identities, configurable own-window drawdown qualification, and Settings controls. It retains losses and existing stage/sample/PF policies.

The executor keeps a durable per-journal namespace, measured maximum leverage, exact relative addition sizing, external-close tombstones and same-position restart suppression. Exact qualified position comparisons retain observed fees, quantity, price and net-return differences, with unknown accounting explicitly unavailable. Current main's bounded warmup and single in-flight stream dispatch remain intact.

Integration review found a scheduler lookup still computing the former shared wire ID. It now searches the durable journal by exact connection and logical intent identity; namespaced unknown entries stay ahead of their own close for reconciliation, even after the paper position disappears. A runtime regression covers this case and cross-connection rejection.

Initial combined validation: 260 tests pass; TypeScript, production build and authenticated runtime/restart smoke pass. The subsequent scheduler/executor/policy group passes 64 tests including the new integration regression. The local browser launch is blocked by the workspace's Unix-socket restriction; hosted browser and complete CI remain mandatory before merge. Tests, typecheck and build are repeated after the scheduler correction by the hosted workflow.

The archived new public-candle request remains a research input, not a completed 50-symbol outcome. This merge performs no exchange or production mutation. Exact combined-head post-Base PF, passed/evaluated market validation, qualified venue fill comparisons and positive live execution PF remain unavailable. Prior failed or losing studies retain their original evidence and labels.
