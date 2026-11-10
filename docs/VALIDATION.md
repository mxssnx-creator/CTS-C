# Validation record

Validation date: **10 November 2026**. This record concerns the fresh, independent CTS-C application in this repository. It distinguishes synthetic tests, local installed-library checks, an actual built server, and exchange observations. Passing tests do not establish trading performance.

## Application evidence

| Check | Evidence and scope |
|---|---|
| Node suite | Latest completed full suite: **95 tests passed**. The authentication-origin correction also passed all 8 targeted auth tests. The latest production rebuild follows the updated executor suite. |
| Production build and dependency audit | Next.js **15.5.29** production build passed. `npm audit` reported **0 vulnerabilities** after PostCSS 8.5.32 override and Sharp 0.35.5 resolution. This is the audit result at validation time, not a permanent security guarantee. |
| Standalone runtime smoke | **Passed after correcting the standalone login origin handling:** clean terminal, authentication, settings persistence, missing-credential rejection, cross-site write rejection, paper CSV, invalid input, restart, and durable logout. The test used blank exchange credentials and submitted zero orders. |
| Interface | Read-only fixture QA passed across six views, five themes/styles, desktop, and mobile. Review the clearly labeled [desktop](ui-review/desktop.jpg) and [mobile](ui-review/mobile.jpg) fixture images; their values are not exchange-account evidence. |
| Authenticated public-data API | The built-server network smoke passed: actual BTC quote, 200 market candles, and 252-configuration replay. It submitted zero orders. This is distinct from fixture browser review. |
| Actual x02 read-only preflight | Succeeded against BingX VST: ready, 0 positions, 0 open orders; **0 orders submitted by the preflight**. This verifies authenticated read access at that moment, not an order round trip. |
| Actual x02 direct-client lifecycle | **Passed for both LONG and SHORT XRP-USDT:** minimum quantity 3 filled, two native SL/TP orders created and observed for each side, protection canceled, exact filled quantity closed, final residual positions/orders both 0. Foreign inventory was preserved. See the compact [evidence record](x02-roundtrip.json). |
| Full autonomous executor lifecycle | Direct-client success does not establish the entire engine → durable executor → fee/protection path. That integration test remains pending. |
| Docker | Docker was unavailable in the authoring workspace. Configuration and build context were inspected; image build, image startup, volume permissions at runtime, and container networking are not verified. |

Reproduce local application checks with Node 24 or newer:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:runtime
```

`npm run check` runs the last four commands in order. The runtime smoke creates a temporary state directory and random administrator password; it starts the standalone server, checks unauthenticated rejection, signs in, reads an initially empty terminal, saves valid settings, rejects invalid settings, rejects x02 startup without dedicated keys, rejects a cross-site write, exports paper CSV, rejects an invalid market symbol, restarts to verify session/settings persistence, then verifies logout remains revoked across another restart. It removes its temporary data after completion and never calls an exchange write endpoint.

The read-only x02 preflight can be reproduced with dedicated variables already exported:

```bash
npm run check:x02
```

For a local environment file, the equivalent explicit command is:

```bash
node --env-file=.env.local --import tsx scripts/x02-preflight.ts
```

The preflight deliberately omits account amounts and secrets from its output. A successful preflight is not evidence of hedge-mode configuration, order execution, correct fee reconciliation, or long-duration operation.

## What the Node tests exercise

The test suite uses deterministic fixtures and mocked exchange transports; only the separately identified x02 observations involve the external venue.

| Area | Important assertions |
|---|---|
| Catalog and causality | Complete catalog cardinality, range/exit identities, chronological processing, future-prefix invariance, invalid-batch atomicity, duplicate suppression, state serialization/restart equivalence. |
| Progression | Fresh child-stage evidence, symbol/direction/config isolation, sufficient samples before admission, distinct economic identities after costs or coordination settings change. |
| Axis / Block / DCA | Disjoint Axis windows, own subsequent outcomes, shared versus additive Block budget, priced DCA fills and weighted entry, cost applied once over accumulated notional. |
| Observed ticks | Existing-position management between bars without creating new indicator signals or changing the completed-bar cursor. |
| Workload | Deterministic 100-symbol processing, including the 252-configuration balanced preset. This is a local synthetic workload, not a latency or live-market throughput guarantee. |
| Transport | Dedicated x02 credential selection, raw-value signing and encoded transport, lossless large IDs, paced reads, exact rejection/unknown handling, no blind POST retry, stable client IDs. |
| Executor | Durable reservation visible before POST, duplicate/concurrent-call idempotency, partial-fill application, restart reconciliation, lane-owned closes, unexplained venue-reduction deferral, unresolved intents retained beyond display windows. |
| Authentication | Opaque sessions, expiry/password rotation, durable revocation, origin checks, malformed/oversized bodies, concurrent login rate-limit enforcement. |
| Public data/replay | Validated identifiers and OHLC, no invented prices on upstream failure, training shortlist invariant to holdout changes. |

The direct exchange exercise bypassed strategy qualification deliberately as a connector diagnostic. It is not evidence that an automatically qualified strategy traded or earned a profit. The completed [observed-market study](market-study.json) replayed 12 symbols × 1,440 completed one-minute candles: **17,280 observed bars, no missing minutes**, 252 configurations per symbol, and zero orders. It reported aggregate Base PF **0.41539** and Main PF **0.11118**. There were 56 currently qualified Base lanes, but no Main lane had the required eight samples; Real and Live had no admissions. These are modeled, cost-adjusted outcomes on actual candle data, not exchange profit. No high-PF or automatically executed strategy result is claimed.

## Research adapter evidence

**17 distinct Python tests passed across three isolated environments.** In the numerical environment, 15 passed and the two separate-environment tests were intentionally skipped; each skipped test then passed with its actual Freqtrade or Cryptofeed dependency installed. The fresh-repository numerical run completed in 28.693 seconds. Package consistency checks passed for all three environments.

| Tool | Tested version | Actual verification |
|---|---|---|
| CCXT | 4.5.92 | Sandbox selected before requests; no credentials; actual fetch returned 99 completed BTC one-minute VST candles after proxy/CA routing correction. |
| TA-Lib | 0.6.8 | Installed EMA/RSI/MACD/ATR calculations, null warmup, prefix invariance. |
| VectorBT | 0.28.5 | Nine EMA candidates, training-only selection, next-open execution, per-fill costs, 150-row holdout equity. |
| skfolio | 0.20.2 | Training fit, feasible capped weights, conservation and separate gross holdout result. |
| QuantStats | 0.0.86 | Real HTML report from 149 synthetic daily holdout returns; no downloaded benchmark. |
| DuckDB | 1.5.6 | Transactional ingestion, duplicate-safe keys, fixtures isolated from exchange-origin records. |
| APScheduler | 3.11.3 | Bounded mocked cycle and a real VST fetch returning 99 candles; overlapping invocation skipped; no trading job. |
| Freqtrade | 2026.10 | Actual strategy/schema and causal fixtures; 45-second public-data dry-run reached RUNNING, simulated a BTC buy, emitted a heartbeat, and exited at its bound. |
| Cryptofeed | 2.5.0 | Actual typed `Trade` replay and validation, plus 20 Kraken public trades captured within 20 seconds. |
| Lightweight Charts | 5.2.1 | Self-contained offline HTML export generated with local installed package; browser behavior is separate UI evidence. |

The numerical environment used Plotly 5.24.1 because VectorBT 0.28 templates are incompatible with Plotly 7's removed `scattermapbox` property. Freqtrade and Cryptofeed were validated in separate Python 3.12.14 environments to avoid incompatible dependency sets. Exact freezes are in `requirements-tested.txt`, `requirements-freqtrade-tested.txt`, and `requirements-feed-tested.txt`.

The nine standard-library contract tests cover candle validity/order/time units, deterministic synthetic provenance, atomic file roundtrip, feasible capped allocations, Freqtrade dry-run boundaries, and equity CSV source/timezone/fee handling. All CLI help paths and Python compilation passed. The Node research service also completed a separate end-to-end smoke: 91 synthetic daily equity snapshots became a hashed/provenance-labeled JSON import and an HTML report with 90 daily returns. It did not modify engine state.

Research dependency presence is not runtime health. `bridge.py health` deliberately does not mark an installed distribution as runtime-verified. `registry.json` describes these local checks, not the status of a deployed process.

## External adapter attempts

The optional Python public-data paths were tested with bounded execution, including initial failures and the corrected successful reruns:

- The initial CCXT failure was traced to default transport settings ignoring standard proxy routing. The corrected adapter preserves TLS verification, accepts configured CA bundles, does not enable netrc authentication, and fetched 99 completed VST candles. The actual scheduled refresh also passed.
- Freqtrade initially failed to load markets. The corrected launcher explicitly honors Requests/aiohttp routing and CA bundles while supplying an empty NETRC. A 45-second spot dry-run then reached RUNNING, loaded three whitelisted pairs, generated a simulated BTC buy, emitted a heartbeat, and exited at its bound with code 0. No exchange keys or order placement were involved.
- Cryptofeed subsequently captured 20 actual Kraken BTC-USD trades in 20 seconds and stopped at the configured bound. The pinned Coinbase route returned HTTP 401 for metadata; Kraken is now the default. The earlier zero-message capture correctly returned failure.

The [compact public-network evidence](research-network.json) records counts, data/log hashes, bounds, and provenance. These observations are specific to those processes and times. The successful Python public-data paths are independent of the separately verified Node x02 account/order paths. Neither establishes sustained feed availability.

## Data and accounting limitations

The terminal's paper records, the actual VST balance response, and the execution journal are separate evidence classes. Paper fees include estimated slippage. The CSV route exports paper equity with `source=engine-paper`; an exchange-origin label must never be applied to that export. QuantStats needs at least 30 daily returns and must not substitute its report statistics for lane or exchange accounting.

Unknown or incomplete exchange settlement must remain visibly unavailable. The implemented importer prefers the actual paginated `fillHistory` response with exact order/trade IDs, signed commission, and venue realized-PnL fields. A read-only check on an owned diagnostic order matched quantity 3, commission -0.00159, and venue realized PnL -0.0102. It keeps accounting unavailable until applied quantity has complete fee coverage. Only an unavailable endpoint (HTTP 404/405) permits the cumulative `allFillOrders` fallback; that mode replaces an exact-order snapshot and never invents trade IDs or missing venue PnL. Local owned-lot net PnL and the exchange-reported realized PnL are separate fields. Native protective orders have their own persisted venue IDs; the direct-client test did not observe any reliable attached-child mapping. Aggregate venue position changes alone cannot identify an individual lane, and unresolved external activity remains deferred. The updated transport and executor passed 23 adapter tests and 17 executor tests; the actual full executor lifecycle is tracked separately and remains pending in this record. Funding, liquidation, and a complete independently reconciled account-NAV report are outside the current paper model.

No full-session profitability result, profitable strategy ranking, universal optimum, mainnet trading, sustained uptime, multi-host concurrency, or Docker runtime result is established by these checks. Tests establish the specific contracts above and their documented limits.

See [README](../README.md) for application setup and [reference integrations](REFERENCE-INTEGRATIONS.md) for adapter commands and primary-source attribution.
