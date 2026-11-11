# CTS-C

CTS-C is an independent trading research and BingX trading application with isolated x02 VST and x01 mainnet accounts built with Next.js, React, TypeScript, Tailwind CSS, and Node.js. It runs a persistent strategy engine, separates paper evaluation from exchange fills, and includes optional adapters for all ten projects in the [reference post](https://x.com/Corki_0x/status/2117534398648098965).

The default workspace starts empty. It imports no earlier application's positions, history, balances, or secrets. Account values appear only after successful exchange requests. Synthetic fixtures are explicitly labeled and confined to research and tests.

## Run locally

Use **Node.js 24 or newer**. The application uses built-in `node:sqlite` and Node 24 JSON source information to preserve exchange order IDs. Python is optional and needed only for the separate research adapters.

```bash
npm ci
cp .env.example .env.local
```

Set `CTS_ADMIN_PASSWORD` in `.env.local` to a password of at least 12 characters, then run:

```bash
npm run dev
```

Open `http://127.0.0.1:3001` and sign in. Without x02 credentials, authentication, settings, saved state, and public-data research remain available; starting exchange processing is rejected. Network-dependent charts report upstream failures instead of inventing prices.

| Variable | Purpose |
|---|---|
| `CTS_ADMIN_PASSWORD` | Required administrator password, minimum 12 characters; server only. |
| `BINGX_X02_KEY`, `BINGX_X02_SECRET` | Dedicated x02 VST credentials; optional until starting x02. |
| `BINGX_X01_KEY`, `BINGX_X01_SECRET` | Dedicated x01 mainnet credentials; optional until explicitly starting x01. |
| `CTS_DATA_DIR` | SQLite directory; defaults to `.data`. The start wrapper resolves it before loading Next; an absolute persistent deployment path is recommended. |
| `CTS_COOKIE_SECURE` | `true` for browser HTTPS; `false` for local HTTP. |
| `CTS_TRUSTED_ORIGINS` | Optional comma-separated complete origins for an explicitly trusted reverse proxy, for example `https://terminal.example.com`. |
| `CTS_HOST`, `PORT` | `npm start` listening address and port; defaults to `127.0.0.1:3001`. Development overrides use CLI flags. |

Credential aliases `BINGX_X02_API_KEY` / `BINGX_X02_API_SECRET` and the corresponding explicit `X01` aliases are accepted. Accounts never inherit one another’s keys. Mainnet stays stopped until explicitly started. Generic BingX credential names are ignored. Credentials belong in server configuration, never strategy exports or browser code.

Override development listening options with `npm run dev -- --hostname 127.0.0.1 --port 3002`. For production, `npm start` loads local `.env.local`/`.env` configuration while preserving already supplied process variables:

```bash
npm run build
CTS_DATA_DIR="$PWD/.data" CTS_HOST=127.0.0.1 PORT=3001 npm start
```

`postbuild` packages static assets with the Next.js standalone server. `scripts/start-server.mjs` resolves the data path before the standalone entry changes its working directory, preserving the same database location across development and production. Run **one application process per state directory**. The runtime and executor are single-process services; use a long-running Node host for automatic processing, not a host that suspends the process between requests.

The main Docker setup is separate from the research containers:

```bash
docker compose up --build -d
docker compose logs -f terminal
```

Compose reads variables from the shell or `.env`, not `.env.local`. Set its required administrator password there. It binds to `127.0.0.1:3001`, runs as a non-root user, and persists SQLite in the `cts_state` volume. It forwards the explicit `CTS_TRUSTED_ORIGINS` configuration for a trusted reverse proxy. The main application image built successfully in GitHub Actions; container runtime verification is a separate CI check recorded in [validation](docs/VALIDATION.md). The authoring workspace itself has no Docker daemon.

To exercise an already built image without exchange credentials:

```bash
docker build -t cts-c:verified .
node scripts/docker-smoke.mjs
```

The smoke uses its own random administrator, ephemeral loopback port, container, and named volume. It checks login, settings/session persistence across container recreation, durable logout, and the missing-x02 block, then removes its resources. It submits no exchange orders.

## Workspace

The terminal includes an account/stage overview, configuration studio, paper positions, exchange execution journal, candle/volume charts, historical replay, and integration status. Five themes and five workspace styles persist in the browser; strategy settings and engine state persist on the server.

Review images from the clearly labeled, isolated UI fixture: [desktop](docs/ui-review/desktop.jpg) and [mobile](docs/ui-review/mobile.jpg). Their displayed fixture values are not exchange-account evidence.

Charts support BingX and Bybit public/demo endpoints and intervals `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, and `1d`. Bybit is a chart/research source only. A chart request retrieves 200 candles. Failed requests produce an unavailable state.

## Strategy engine

Each evaluation lane is isolated by connection, symbol, configuration, direction, coordination, and stage. Signals use completed observed bars. Existing positions also react to observed quote ticks. Duplicate candles are ignored and malformed batches fail before mutation. Warmup initializes paper evaluation without submitting historical orders.

The original moving-average cross, RSI band, MACD signal and Bollinger bounce indications combine with take-profit steps, stop-loss ratios, and fixed, trailing-after-target, or trailing-only exits.

| Range | TP steps | Maximum hold |
|---|---:|---:|
| Micro | 2–5 | 15 minutes |
| Low-Range | 2–8, independent overlapping configurations | 15 minutes |
| Minimal | 6–8 | 30 minutes |
| Short | 9–12 | 60 minutes |
| Normal | 13–18 | 240 minutes |
| Long | 19–24 | 720 minutes |
| Wide | 25–30 | 1,440 minutes |

TP distance is estimated round-trip position cost multiplied by the selected step. SL distance is TP distance multiplied by the selected ratio. Micro and Low-Range accept **0.2–1.6 in increments of 0.1**. Fee inputs use percent units: `0.05` means `0.05%`. Defaults are maker 0.02%, taker 0.05% per side, and slippage equal to 10% of those fees. Market entry plus market exit therefore model **0.11% total**, not 0.22%. On connection startup one account commission read supplies each selected symbol's verified fee economics, which take precedence over fallbacks. Actual fills use signed exchange commissions, without an additional modeled fee deduction. New fee economics create new cohorts; open positions keep captured costs.

The balanced default retains seven TP steps (`3, 5, 8, 12, 18, 24, 30`), three SL ratios (`0.6, 1, 1.4`), four core indications, and three exits: **252 configurations per symbol**. All 29 steps with 15 ratios and those four indications produce 5,220 configurations before optional Low-Range overlaps. The Micro + Low-Range preset selects steps 2–5, all 15 ratios, three exits and both 10-second and one-minute signals: 2,880 configurations per symbol with four core indications. Other tactics, periods and timeframes remain independently selectable. Directions, coordinations, and stages create separate lanes; these are not simultaneous order counts.

Micro and Low-Range trailing width defaults to half the selected SL distance (adjustable), with the existing dynamic peak ratchet and fixed initial stop. Auto PF is optional and computes each configuration's floor once: `max(stage floor, 1.01, min(cap, 1 + floor(TP_percent × 10) / 10 × slope))`. It changes qualification thresholds, never samples or reported returns. The Micro preset enables Auto PF and processed-set progression; a child retains its admission proof and learns from its own subsequent trades, while Real remains the current execution gate.

### Observed 10-second history

The optional trade stream uses the exchange's compressed `@trade` WebSocket feed and builds 10-second OHLCV from observed trades. x02 uses the VST WebSocket host. Fifty symbols use three sockets, with per-socket heartbeat checks, bounded queues and reconnect handling. Trade IDs are deduplicated when supplied; VST messages observed during verification omit IDs, which remain explicitly unavailable. The partial first bucket and gaps are excluded from signal history; reconnects reset continuity. No sub-minute candles are invented from one-minute data.

Complete and incomplete recorded bars persist for three days in SQLite. Ten-second and minute signals have independent timestamps and evidence. During minute warmup, present-time ticks only affect sub-minute lanes; they cannot close historical minute positions. REST reads run in the background, and history work yields in bounded batches so the trade loop can continue. The 100ms timer is a scheduling target, not a measured exchange execution latency guarantee. See [Micro verification](docs/MICRO-20261111.md) for results and limitations.

Progression is **Base → Main → Real → Live**. A child stage begins only while all matching preceding lanes meet their independent sample and PF gates. Each child records its own subsequent results; parent samples are never copied forward. Defaults are 20 Base closes, 8 Main closes, 8 Real closes, and PF 1.1 at each gate. The runtime rechecks current qualification after asynchronous preflight before entry/add submission. Rolling qualification can decline as results change.

Replay and the engine share observed-price exits and independent long/short position handling. Catalog version 4 uses a peak-proportional trailing distance, persists activation and ratchets the stop across weighted-entry additions. Its economic identity is separate from prior cohorts. Restored older positions retain their earlier exit basis, historical losses and ownership; disabled symbols remain monitored through closure. Changing the symbol universe or refreshing fees on startup no longer waits for every research position to close.

The dashboard distinguishes currently validated windows, admitted forward outcomes with immutable parent-gate evidence, exchange execution PF, current cohorts, parent-gate holds and lifetime PF. Validated windows are a current selection statistic; admitted and exchange PF retain subsequent losses. Lifetime Live-paper P&L and win rate are independent of the display limit; Live-paper history retains its own latest 1,000 closes. Old checkpoints without complete fee totals display those costs as unavailable.

PF divides positive net percentage outcomes by the absolute sum of negative outcomes. Positive windows with no losses use internal sentinel 999; empty/flat windows use 1 internally. Explicit `pfState` metadata lets the UI distinguish no-loss windows (`∞`) from a finite PF of 999 and from empty or flat results. Neither a sentinel nor a qualification gate predicts returns.

| Coordination | Behavior |
|---|---|
| Normal | Initial fill with the selected exit rules. |
| Axis | Requires disjoint previous/recent Normal-lane windows; checks previous PF and the selected recent-outcome condition before starting its own evaluation. |
| Block | Configurable completed-position rounds or favorable-move pyramiding. Rounds evaluate N net closes independently per lane, increase the next round's base budget after a loss, retain the increase until net recovery, then pause complete rounds of eligible signals. Steps and multiplier cap bound the increase. Shared/additive applies to pyramiding. |
| DCA | Adds after a configured adverse movement with bounded additions and a sizing multiplier; updates weighted entry and costs. |

The studio exposes range, step, ratio, exit, indication, gate, sizing, cost, Axis, Block, and DCA settings. Validated settings JSON can be exported and imported; an import updates the draft and requires the normal Save action. Changes generate new economic identities where needed, so incompatible configurations cannot borrow historical samples. Open positions retain their captured sizing and exit terms.

Initial paper sizing is `baseNotional × volumeFactor × coordination ratio`: by default `100 × 0.01 = 1 USDT`, before coordination adjustments. The executor normalizes the entry so that its smallest planned relative add can meet exchange minimums, then applies the same actual-entry scale to adds. Invalid small adds and orders above the notional cap are rejected before canceling existing protection. Confirmed receipts determine actual fills. The default universe targets 100 available contracts with a fixed initial symbol priority, not a volatility ranking or guaranteed selection of the best markets.

## x02 execution

The x02 client is fixed to `https://open-api-vst.bingx.com`; the x01 client is fixed to `https://open-api.bingx.com`. Each has dedicated credentials, engine, lease and journal. Authentication stays in the root store; x01 state is in its `x01` subdirectory. The UI and API select a whitelisted connection, never an arbitrary exchange host. Dedicated keys and hedge position mode are required. Account mode is checked, not silently changed.

With variables exported into the process, run the read-only preflight:

```bash
npm run check:x02
```

It reads balance, positions, and open orders, prints redacted status, and submits **zero orders**. Unlike Next.js, the plain Node script does not automatically load `.env.local`; use this explicit form for a local file:

```bash
node --env-file=.env.local --import tsx scripts/x02-preflight.ts
```

Starting x02 in the terminal verifies the account and contracts, warms symbols, and starts the persistent loop. Warmup defaults to 1,440 completed one-minute candles per symbol and is configurable from 100 to 1,440. Only eligible Live-stage paper entries can produce new exchange intents. A new loop pass is scheduled after the previous pass finishes; this is not a fixed-frequency or low-latency execution guarantee. Pause disables new entries/additions while continuing market processing and eligible owned closes. It is not account-wide liquidation.

### Continuous supervisor

With the administrator password and dedicated x02 credentials configured, run this from the repository root on an available `PORT` (default 3001):

```bash
npm run build
node scripts/run-x02.mjs --execute
```

The supervisor launches its own production server on `127.0.0.1`, signs in, saves **50 symbols, 1,440 warmup candles, volume factor 0.01, and a 10 USDT per-order cap** (`--symbols N` overrides the count), then enables x02 VST execution through the normal qualification gates. Other saved strategy settings remain in use. Run one server for that port/state directory.

Large saved states can take longer to initialize: startup requests allow 120 seconds. A known ownership conflict before settings are changed may wait up to 60 seconds for the previous lease to expire; ambiguous trading actions are never blindly retried. Restored symbols recover the oldest missing closed candles first in chunks up to the configured history size, even after a longer interruption. A gap, stale response, or changed cursor prevents that symbol from being marked warm until the missing data are available. A detected live quote gap also sends that symbol back through recovery; historical replay does not submit new entries.

Status is refreshed about every five seconds in `CTS_DATA_DIR/x02-runtime-observation.json`; server output goes to `CTS_DATA_DIR/runtime-server.log`. Both files are created with mode `0600`. The default data directory is `.data`, which is gitignored; keep these operational records private when using another directory. Check the observation's `checkedAt` timestamp: an old file does not establish that the process is still running.

This foreground supervisor runs while its host process remains alive. A workspace suspension or shutdown can stop it; the workspace is not a managed 24/7 service. Use a persistent host and a process manager for unattended operation. Initial startup or server failure exits the helper and requires an external restart; transient status, authentication, or network observation failures are retried. `Ctrl+C` stops the local processes without liquidating exchange positions. Saved running state can resume on a later server startup.

### Order ownership

Orders have deterministic identities and a SQLite reservation committed before the network write. Unknown outcomes are queried rather than blindly resubmitted. Accepted requests are distinct from fills. Partial fills update lots by incremental confirmed quantity. Closes are bounded by that lane's owned lot; another lane's position or paper requested size cannot enlarge a close. Before position-changing writes and new protection, CTS-C compares the exchange quantity with its own lots and checks open orders against exact journaled venue IDs. An unrelated position or order on the same symbol and hedge side defers that side; unrelated symbols and the opposite hedge side are not canceled or modified. Malformed inventory responses also defer writes.

BingX aggregates positions by symbol and hedge side. Inventory reads and subsequent writes are not an account-wide lock, so another process can still change that aggregate between them. The local SQLite lease coordinates only processes sharing the same state directory. Do not run a restored copy alongside its original, and use an independently coordinated account when concurrent external activity must be excluded.

After a confirmed entry fill, the executor creates separate native stop-loss and, for fixed exits, take-profit orders and persists their acknowledged venue IDs. Protection is a subsequent request, not an atomic bracket: its status can be pending, active, unknown, or failed. Before an add/close, owned protective orders are canceled and reconciled; resized protection uses the confirmed remaining quantity. Trailing behavior depends on the running engine.

Separate native IDs establish ownership without guessing an attached order's parent. A lost conditional-order reply remains unresolved because the venue does not support custom client IDs for those order types. Aggregate position reductions alone are never assigned to a strategy. The direct native lifecycle and durable executor entry/add/protection-resize/close lifecycle have been tested on x02 with actual fee reconciliation. A separate natural LONG stop-loss trigger also verified explicit parent-child linkage and exact fill attribution; the sibling TP was canceled. This is distinct from the executor-driven entry/add/close diagnostic, and an actual TP trigger was not exercised. See [validation](docs/VALIDATION.md), [executor evidence](docs/x02-executor-roundtrip.json), and [native-trigger evidence](docs/x02-native-trigger.json).

## Accounting and research boundaries

| View | Meaning |
|---|---|
| Paper stage/position results | Observed-price model with estimated fees/slippage. The recent table retains at most 1,000 closes across all stages; lifetime lane statistics are separate. |
| VST account equity | Direct exchange balance reading; becomes unavailable when stale rather than falling back to paper equity. |
| Execution journal | Exchange requests, confirmed fills, owned lots, native protection, and exact-order fee reconciliation. Incomplete accounting stays unavailable; modeled costs never substitute for actual commission. |

Paper unrealized PnL uses recent marks and becomes unavailable when stale. Paper equity/drawdown reflect realized Live-stage paper closes, not marked-to-market exchange NAV. The execution importer deduplicates trade IDs for exact known order IDs, preserves signed fee cash flows, and reports local lot gross PnL less confirmed fees separately from the venue's realized-PnL field. Net figures exclude funding and remain unavailable until all applied fills have fee coverage. Validation of that complete path is recorded in [validation](docs/VALIDATION.md).

Terminal historical replay splits chronological candles 65/35 into training/holdout, freezes up to three training candidates per range, and evaluates them on the holdout. It cannot submit orders or automatically change active settings. Its equal-size percentage-return totals are not account equity growth. Replay observes candle closes, not an invented intrabar path. A short 200-candle response may have insufficient evidence; insufficient samples remain visible.

## Architecture and state

| Area | Files |
|---|---|
| Interface | `app/`, `components/terminal/` |
| Strategy engine/catalog/replay | `core/engine.ts`, `catalog.ts`, `replay.ts`, `terminal-replay.ts` |
| Persistent market loop | `core/runtime.ts` |
| VST transport and owned execution | `core/bingx.ts`, `executor.ts` |
| SQLite state/journal/sessions | `core/store.ts` |
| Authentication/origin checks | `core/auth-policy.ts`, `auth.ts` |
| Optional research | `integrations/research/` |

SQLite uses WAL and `synchronous=FULL`. Engine checkpoints and their buffered events commit atomically; ordinary paper checkpoints are throttled to five seconds, while pending execution and explicit settings changes force persistence. An abrupt process failure can therefore lose paper-only changes since the last checkpoint. Order reservations commit before POST.

A renewable SQLite lease prevents a second local runtime from taking ownership of the same state directory. Ownership is checked again before exchange submission; lease loss stops that runtime until it is restarted and reloads durable state. This is not a verified multi-host deployment design.

The data directory is created with restricted permissions. For a simple consistent backup, stop the application and copy its entire data directory, keeping SQLite/WAL/shared-memory files together. Do not replace an active database to reset the UI.

Eight-hour sessions use HttpOnly, SameSite=Strict cookies. Only a token digest is stored. Logout remains revoked across restart; changing the administrator password invalidates existing cookies. Writes check their origin. The login limiter is process-local, not a distributed abuse-control service.

`GET /api/health` publicly reports application/SQLite readiness only. Terminal, market, replay, and export routes require authentication:

| Route | Function |
|---|---|
| `GET /api/terminal` | Engine, account, settings, events, and execution snapshot |
| `POST /api/terminal` | `save-settings`, `configure-x02`, `start-x02`, `pause-x02` |
| `GET /api/terminal/export` | Paper equity CSV: `timestamp,equity,drawdownPct,source` |
| `POST /api/terminal/replay` | Independent chronological research |
| `GET /api/market-data/candles` | Validated venue/symbol/interval/demo candle data |
| `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` | Session lifecycle |

## Ten reference integrations

The post supplies a tool list, not reproducible strategy parameters. These optional adapters use explicit file contracts and never place orders. The Node executor remains the sole exchange writer.

| Tool | Included function | Verified local scope |
|---|---|---|
| Cryptofeed | Bounded Kraken public trade capture; optional Coinbase adapter | Real typed-trade replay; 20 actual Kraken trades captured in 20 seconds |
| CCXT | Credential-free BingX VST candles | Sandbox configuration; 99 actual completed VST candles fetched |
| Freqtrade | Isolated BingX **spot dry-run** comparison | Installed schema/strategy; real 45-second public-data dry-run with simulated fill |
| VectorBT | Nine-candidate EMA research baseline | Training-only selection and held-out equity with fill costs |
| TA-Lib | EMA, RSI, MACD, ATR | Real indicators, null warmup, causal prefix checks |
| skfolio | Capped inverse-volatility proposal | Training fit, normalized weights, separate holdout result |
| QuantStats | Daily equity HTML reports | Actual HTML generation and bounded Node-to-Python CSV handoff |
| DuckDB | Separate research database | Transactional, duplicate-safe, provenance-separated ingestion |
| APScheduler | Bounded public-data refresh | Mocked cycle and one actual bounded VST fetch |
| Lightweight Charts | Native candle/volume chart and offline export | Installed v5 export; UI has separate checks |

These describe local verification and the [bounded public-data checks](docs/research-network.json), not deployed service uptime. Python dependencies are optional and separate from `npm ci`; use Python 3.12 for the tested research environments. [REFERENCE-INTEGRATIONS.md](docs/REFERENCE-INTEGRATIONS.md) includes pinned environments, full commands, source attribution, contracts, tests, and independent `compose.research.yml` profiles. Research containers receive no exchange credentials. Their Docker build/run verification is outstanding.

The terminal CSV contains **paper equity** and must use `engine-paper` provenance:

```bash
node integrations/research/service.mjs --python integrations/research/.venv/bin/python --csv paper-equity.csv --origin engine-paper --account x02-paper --out-dir integrations/research/output
```

This bounded importer/reporter needs at least 30 daily returns. It never changes engine state or deducts fees again. An exchange report requires a separately reconciled exchange-equity series; relabeling a file does not reconcile it.

## Checks and limits

```bash
npm run typecheck
npm test
npm run build
npm run test:runtime
```

`npm run check` runs that sequence. The standalone smoke uses isolated temporary state, blank exchange credentials, login/write protection, persisted settings, restart, and durable logout. It submits no exchange orders. [VALIDATION.md](docs/VALIDATION.md) separates those checks from actual x02 checks and optional-adapter checks.

`npm run test:browser` checks the built terminal with an isolated deterministic fixture, blank exchange keys, and a transport that rejects exchange writes. It exercises all six views, saved and unsaved settings, import/export, the replay UI→API→data→results flow, mobile layout and logout. Install Chromium with `npx playwright-core install --with-deps chromium`, or set `CTS_CHROMIUM_PATH` to an existing Chromium executable. Research accepts 100–5,000 completed candles, rejects gaps/stale data, carries training indicator prehistory into fresh holdout positions, and yields between candidates to keep the event loop responsive.

The application currently has one x02 executor and no portfolio-wide capital reservation, risk optimizer, or verified multi-host worker coordination. Independent candidate exposure does not imply available exchange margin. Replay does not model funding, liquidation, depth, queue priority, or exchange latency. Verification does not establish profitability or universally best configurations.

See [engine v4 contracts and research](docs/ENGINE-V4.md) for Trend/Break methods, PF scopes, entry provenance, ratio preservation, and verification boundaries.
