# CTS-C

CTS-C is an independent trading research and BingX VST demo application built with Next.js, React, TypeScript, Tailwind CSS, and Node.js. It runs a persistent strategy engine, separates paper evaluation from exchange fills, and includes optional adapters for all ten projects in the [reference post](https://x.com/Corki_0x/status/2117534398648098965).

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
| `CTS_DATA_DIR` | SQLite directory; defaults to `.data`. The start wrapper resolves it before loading Next; an absolute persistent deployment path is recommended. |
| `CTS_COOKIE_SECURE` | `true` for browser HTTPS; `false` for local HTTP. |
| `CTS_TRUSTED_ORIGINS` | Optional comma-separated complete origins for an explicitly trusted reverse proxy, for example `https://terminal.example.com`. |
| `CTS_HOST`, `PORT` | `npm start` listening address and port; defaults to `127.0.0.1:3001`. Development overrides use CLI flags. |

Credential aliases `BINGX_X02_API_KEY` and `BINGX_X02_API_SECRET` are accepted. Generic BingX credential names are ignored. Credentials belong in server configuration, never strategy exports or browser code.

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

Compose reads variables from the shell or `.env`, not `.env.local`. Set its required administrator password there. It binds to `127.0.0.1:3001`, runs as a non-root user, and persists SQLite in the `cts_state` volume. It forwards the explicit `CTS_TRUSTED_ORIGINS` configuration for a trusted reverse proxy. Docker builds and container execution have not been verified in this workspace.

## Workspace

The terminal includes an account/stage overview, configuration studio, paper positions, exchange execution journal, candle/volume charts, historical replay, and integration status. Five themes and five workspace styles persist in the browser; strategy settings and engine state persist on the server.

Review images from the clearly labeled, isolated UI fixture: [desktop](docs/ui-review/desktop.jpg) and [mobile](docs/ui-review/mobile.jpg). Their displayed fixture values are not exchange-account evidence.

Charts support BingX and Bybit public/demo endpoints and intervals `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, and `1d`. Bybit is a chart/research source only. A chart request retrieves 200 candles. Failed requests produce an unavailable state.

## Strategy engine

Each evaluation lane is isolated by connection, symbol, configuration, direction, coordination, and stage. Signals use completed observed bars. Existing positions also react to observed quote ticks. Duplicate candles are ignored and malformed batches fail before mutation. Warmup initializes paper evaluation without submitting historical orders.

Four indications—moving-average cross, RSI band, MACD signal, and Bollinger bounce—combine with take-profit steps, stop-loss ratios, and fixed, trailing-after-target, or trailing-only exits.

| Range | TP steps | Maximum hold |
|---|---:|---:|
| Micro | 3–5 | 15 minutes |
| Minimal | 6–8 | 30 minutes |
| Short | 9–12 | 60 minutes |
| Normal | 13–18 | 240 minutes |
| Long | 19–24 | 720 minutes |
| Wide | 25–30 | 1,440 minutes |

TP distance is estimated round-trip position cost multiplied by the selected step. SL distance is TP distance multiplied by the selected ratio. Fee inputs use percent units: `0.08` means `0.08%`. Slippage is a percentage of estimated fees. On x02 startup without open paper positions, the runtime attempts to read exchange commission before updating catalog costs.

The balanced default uses seven TP steps (`3, 5, 8, 12, 18, 24, 30`), three SL ratios (`0.6, 1, 1.4`), four indications, and three exits: **252 core configurations per symbol**. The complete selectable catalog has **3,696 configurations**: 28 steps × 11 ratios × 4 indications × 3 exits. Directions, coordinations, and stages create separate lanes; this count is not a simultaneous order count.

Progression is **Base → Main → Real → Live**. A child stage begins only after its matching parent lane completes the required samples and meets its PF threshold. Each child then records its own subsequent results; parent samples are never copied forward. Defaults are 20 Base closes, 8 Main closes, 8 Real closes, and PF 1.1 at each gate. Rolling qualification can decline as results change.

PF divides positive net percentage outcomes by the absolute sum of negative outcomes. Positive windows with no losses use internal sentinel 999; empty/flat windows use 1 internally. Missing evidence is displayed separately. Neither a sentinel nor a qualification gate predicts returns.

| Coordination | Behavior |
|---|---|
| Normal | Initial fill with the selected exit rules. |
| Axis | Requires disjoint previous/recent Normal-lane windows; checks previous PF and the selected recent-outcome condition before starting its own evaluation. |
| Block | Adds after favorable movement. Shared mode distributes a fixed budget; additive mode increases it. |
| DCA | Adds after a configured adverse movement with bounded additions and a sizing multiplier; updates weighted entry and costs. |

The studio exposes range, step, ratio, exit, indication, gate, sizing, cost, Axis, Block, and DCA settings. Changes generate new economic identities where needed, so incompatible configurations cannot borrow historical samples. Open positions retain their captured sizing and exit terms.

Initial paper sizing is `baseNotional × volumeFactor`: by default `100 × 0.01 = 1 USDT`, before coordination adjustments. Exchange minimums can raise submitted quantity; confirmed receipts determine actual fills. The default universe targets 100 available contracts with a fixed initial symbol priority, not a volatility ranking or guaranteed selection of the best markets.

## x02 execution

The exchange writer is fixed to `https://open-api-vst.bingx.com`; it has no mainnet switch. Dedicated x02 keys and hedge position mode are required. Account mode is checked, not silently changed.

With variables exported into the process, run the read-only preflight:

```bash
npm run check:x02
```

It reads balance, positions, and open orders, prints redacted status, and submits **zero orders**. Unlike Next.js, the plain Node script does not automatically load `.env.local`; use this explicit form for a local file:

```bash
node --env-file=.env.local --import tsx scripts/x02-preflight.ts
```

Starting x02 in the terminal verifies the account and contracts, warms symbols, and starts the persistent loop. Warmup defaults to 1,440 completed one-minute candles per symbol and is configurable from 100 to 1,440. Only eligible Live-stage paper entries can produce new exchange intents. A new loop pass is scheduled after the previous pass finishes; this is not a fixed-frequency or low-latency execution guarantee. Pause disables new entries/additions while continuing market processing and eligible owned closes. It is not account-wide liquidation.

Orders have deterministic identities and a SQLite reservation committed before the network write. Unknown outcomes are queried rather than blindly resubmitted. Accepted requests are distinct from fills. Partial fills update lots by incremental confirmed quantity. Closes are bounded by that lane's owned lot; another lane's position or paper requested size cannot enlarge a close. Unexplained venue reductions defer affected activity for reconciliation.

After a confirmed entry fill, the executor creates separate native stop-loss and, for fixed exits, take-profit orders and persists their acknowledged venue IDs. Protection is a subsequent request, not an atomic bracket: its status can be pending, active, unknown, or failed. Before an add/close, owned protective orders are canceled and reconciled; resized protection uses the confirmed remaining quantity. Trailing behavior depends on the running engine.

Separate native IDs establish ownership without guessing an attached order's parent. A lost conditional-order reply remains unresolved because the venue does not support custom client IDs for those order types. Aggregate position reductions alone are never assigned to a strategy. The direct native lifecycle has been tested on x02; end-to-end executor verification is tracked separately in [validation](docs/VALIDATION.md).

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

These describe local verification and the [bounded public-data checks](docs/research-network.json), not deployed service uptime. Python dependencies are optional and separate from `npm ci`. [REFERENCE-INTEGRATIONS.md](docs/REFERENCE-INTEGRATIONS.md) includes pinned environments, full commands, source attribution, contracts, tests, and independent `compose.research.yml` profiles. Research containers receive no exchange credentials. Their Docker build/run verification is outstanding.

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

The application currently has one x02 executor and no portfolio-wide capital reservation, risk optimizer, or verified multi-host worker coordination. Independent candidate exposure does not imply available exchange margin. Replay does not model funding, liquidation, depth, queue priority, or exchange latency. Verification does not establish profitability or universally best configurations.
