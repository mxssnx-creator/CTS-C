# CTS-C old PR #1 audit — 2026-11-12

## Compared revisions

- Old draft: `#1`, `agent/production-dashboard`, head `f956435e6198251efaf1ac3cbcf09aa5fbf23541`.
- Current target: `main`, head `2f3a65b300933b35945fa55f3cb196ce2b405d04`, tree `b3d6722c34f7ac9240817fce838006766028c286`.
- Exact merge base: `f6d9119227ba3ba777e6052cb734f0a525eba603`.
- The old draft has three commits after that base. Current `main` has 62 commits after the same base. The branches diverge; the draft changes 895 files and GitHub reports it as non-mergeable.

This is a semantic audit of the three draft commits, not a bulk merge of their old application tree.

## Claim-by-claim disposition

| Old PR #1 claim | Current implementation and executable evidence | Disposition |
| --- | --- | --- |
| Synchronize BingX server time and recover safe signed reads | `core/bingx.ts` maintains a measured offset and receive window, prevents future signatures, deduplicates concurrent clock synchronization, and retries only eligible reads after clock errors. `tests/bingx.test.ts` covers generic `109400`, asymmetric slow transport, and bounded receive windows. | Replaced by a smaller fail-closed transport with stronger tests. |
| Retry safe GET requests without turning failures into empty account state | `BingxClient.read` limits retries to reads. Position and open-order parsers reject malformed inventory. `DemoExecutor` defers writes when inventory cannot be read; `reconcileExternalClosures` returns without modifying lots if the position read fails. Tests cover malformed, unavailable, and partial inventory. | Integrated and strengthened. |
| Resolve ambiguous POST outcomes by unique client order ID | `submitOrder` never replays an ambiguous POST. Identifiable orders are reconciled by `clientOrderId`; unsupported standalone conditional responses remain `unknown`. The SQLite executor journal is written before the venue call and survives restart. Tests cover lost responses, HTTP 503, concurrent duplicates, restart, and lost writer leases. | Integrated and strengthened. |
| Retain order history for restart and audit continuity | Current execution uses an unbounded durable own-intent journal plus exact owned order/fill reconciliation, preserving large venue IDs, partial fills, signed fees, and parent/child trigger IDs. A diagnostic history read is deliberately symbol-scoped and bounded to one day; restart recovery does not depend on a broad seven-day account scan. | Replaced by exact owned-ledger continuity. The old broad scan is intentionally not ported. |
| Bound request concurrency/rate | `BingxClient.reserveStart` serializes request starts with a configured minimum interval; endpoint cooldowns prevent repeated rate-limit traffic without blocking unrelated reads. Tests cover concurrent pacing and cooldown isolation. | Integrated and strengthened. |
| Preserve positions when exchange inventory is unavailable | Inventory failures never become an empty array and never settle owned lots. Entries/additions are deferred on unreadable positions/orders; external closure requires repeated valid observations. | Integrated and strengthened. |
| Track native stop-loss and take-profit orders | Entries may attach native protection atomically. Resized lots use durable standalone protection intents; exact venue IDs, partial fills, sibling cancellation, and residual quantity are reconciled. Unknown protection is never resubmitted and blocks more exposure. | Integrated and strengthened. |
| Default to no exchange writes and require an explicit live gate | `DEFAULT_CONTROL.exchangeExecution` is `false`. Starting execution requires dedicated connection credentials, a writer lease, a successful fee read, and the explicit `start-x02` action. Pausing/stopping persists the disabled gate. Runtime and policy tests verify these boundaries. | Integrated with a narrower x02-only gate. |
| Standalone, route, restart, shutdown, browser, and container smoke gates | CI runs typecheck, unit/integration tests, production build, runtime restart smoke, authenticated browser smoke, research-contract tests, Docker build, and Docker runtime smoke. The runtime smoke verifies credential refusal, CSRF, persistence, restart, and durable logout; browser shutdown uses `SIGTERM`. | Replaced by the current independent verification pipeline. |
| Mainnet live acceptance described in the old PR | Current acceptance scope is BingX VST at `https://open-api-vst.bingx.com`. Dedicated x02 credentials cannot fall back to x01. Historical mainnet claims are not reused as current evidence. | Intentionally excluded from the current target and this audit. |

## Validation on the current target

Run from a clean detached worktree at `2f3a65b300933b35945fa55f3cb196ce2b405d04`:

```text
npm run typecheck
node --import tsx --test tests/bingx.test.ts tests/executor.test.ts tests/runtime-policy.test.ts tests/runtime-restore.test.ts
```

Result: TypeScript passed; 77 tests passed, 0 failed, 0 skipped. No exchange request or account write was made by this audit.

## Merge decision

PR #1 must not be merged. Its current tree would replace newer engine, ownership, stage, strategy, UI, and evidence work with the July application and would reintroduce weaker account-wide assumptions. Every publishable execution-hardening claim is present or deliberately superseded above. The old draft can be closed as superseded once this audit itself is merged after green CI.

This audit does not claim a completed twelve-symbol forward acceptance or positive forward profit factor. Those remain separate open acceptance work and cannot be inferred from transport correctness.
