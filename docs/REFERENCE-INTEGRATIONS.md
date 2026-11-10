# Reference integrations

CTS-C combines a Node/Next.js execution application with optional, isolated research tools. The Node trading engine is the sole exchange-order authority. The scripts below read public data or calculate offline results; they never import account credentials, place orders, replace stage validation, or apply research winners to live settings.

## What the reference actually supplies

The [original Corki post](https://x.com/Corki_0x/status/2117534398648098965), dated 3 November 2026, was readable through its [public mirror](https://teapawt.net/Corki_0x/status/2117534398648098965). It lists ten open-source projects and advocates one execution service, order-status reconciliation before retry, a complete dry-run session, and separate reporting of realized profit, open positions, fees, and failed orders. It does not publish actual signal settings or reproducible evidence for its advertised returns. CTS-C does not treat those returns as validation data or a promised outcome.

## Integration map

| Project | Implementation | Boundary |
|---|---|---|
| [Cryptofeed](https://github.com/bmoscon/cryptofeed) | `integrations/research/feed.py`: bounded Kraken trade capture to JSONL; optional Coinbase route | Kraken network capture verified; the pinned Coinbase adapter returned HTTP 401 during symbol lookup. Upstream does not list BingX support. These feeds never substitute for x02 execution prices. |
| [CCXT](https://github.com/ccxt/ccxt) | `bridge.py fetch` / `schedule`: BingX swap VST candles, sandbox set before requests | No key/secret and no order methods; unfinished candles are discarded. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | `freqtrade.spot.json`, `CTSResearchStrategy.py`, `freqtrade_dry_run.py` | Independent BingX **spot** dry-run comparison. Official support does not list BingX futures. Wrapper forces dry-run, rejects credential aliases including nested CCXT fields, strips Freqtrade environment overrides, and has a duration limit. |
| [VectorBT](https://github.com/polakowo/vectorbt) | `bridge.py backtest`: nine independent EMA candidates with a chronological 70/30 train/holdout split | Candidate selection uses training only; signals execute next open; fees and slippage apply per fill. This is an independent baseline, not the CTS Axis/Block/DCA execution model. |
| [TA-Lib Python](https://github.com/TA-Lib/ta-lib-python) | `bridge.py indicators`: RSI, EMA, MACD, ATR | Warmup values remain null; no fabricated indicator values. |
| [skfolio](https://github.com/skfolio/skfolio) | `bridge.py allocate`: fit inverse-volatility weights on training returns, cap weights, report holdout gross return | Research proposal only, never automatically applied. Allocation result explicitly excludes turnover, fees, and slippage. |
| [QuantStats](https://github.com/ranaroussi/quantstats) | `bridge.py report`: HTML report from daily holdout or imported engine equity returns | Minimum 30 daily observations. No network benchmark downloads. Synthetic input stays labeled synthetic. |
| [DuckDB](https://github.com/duckdb/duckdb) | `bridge.py store`: transactional candle ingestion, duplicate-safe primary key | Separate research database, not the execution ledger. |
| [APScheduler](https://github.com/agronholm/apscheduler) | `bridge.py schedule`: bounded public-candle refresh, one concurrent job, coalescing | No trade scheduler or execution triggers. Uses the stable 3.x API. |
| [Lightweight Charts](https://github.com/tradingview/lightweight-charts) | `chart.mjs` offline candle export using the locally installed v5 library | Data source stays explicit; includes TradingView attribution and makes no exchange calls. Dashboard chart integration belongs to the fresh Node application. |

These integrations are adapters, not a claim that ten independent bots are operating a trading account. Data from the isolated research tools is not automatically ingested into the Node production pipeline.

All source, config, and tests in this folder are standalone. They were ported into the fresh CTS-C repository without old application code, account files, credentials, generated outputs, or virtual environments. The engine-to-research boundary is an explicit data contract; there are no imports from earlier CTS projects.

## Fresh engine ledger handoff

Export equity snapshots from the fresh Node engine as CSV with columns `timestamp,equity`. The authenticated `/api/terminal/export` endpoint exports **paper equity**, so use `engine-paper` for that file. A VST origin requires a separately reconciled exchange-equity series. Use Unix milliseconds or timezone-aware ISO timestamps. The `equity` column must contain the complete equity value at each timestamp; fills or trade PnL alone are insufficient. The importer preserves these values and does not deduct fees or funding again. It rejects duplicates, ambiguous timezones, and nonfinite/negative equity. Other column names can be selected explicitly.

```bash
python integrations/research/bridge.py ledger-csv equity.csv --time-column timestamp --equity-column equity --origin engine-paper --account x02-paper --out integrations/research/output/ledger-equity.json
python integrations/research/bridge.py report integrations/research/output/ledger-equity.json --out integrations/research/output/equity-tearsheet.html
```

For a single bounded service command with the research environment installed:

```bash
node integrations/research/service.mjs --python integrations/research/.venv/bin/python --csv equity.csv --origin engine-paper --account x02-paper --out-dir integrations/research/output
```

`service.mjs` invokes only the importer and reporter via argument arrays with shell evaluation disabled. Each child has a two-minute bound and receives a small environment allowlist without exchange credentials. It reads an exported CSV, writes a JSON audit record and HTML report, and never contacts an exchange. Sources are explicitly declared as `engine-paper`, `engine-vst`, `engine-mainnet`, `imported-unverified`, or `synthetic-fixture`; a file hash is retained. Declared provenance is not proof of exchange reconciliation. At least 30 daily returns are needed for the report, and empty days carry the last supplied equity. QuantStats return statistics are separate from CTS lane/stage PF and must not replace execution-ledger calculations.

## Container services

`compose.research.yml` is independent of the main Node application compose file. Its build context is only `integrations/research`, with an explicit Docker ignore allowlist; account files, environments, and generated outputs are excluded. There are three image targets: numerical research, Freqtrade spot dry-run, and Cryptofeed public capture. Containers run as a non-root user with a read-only root filesystem, a temporary cache directory, and named report volumes. No exchange key environment or `env_file` is configured, and offline services have networking disabled.

Public adapters honor standard proxy routing and configured CA bundles without disabling TLS verification. The Freqtrade launcher supplies an empty NETRC to prevent ambient account authentication. Container deployments on a managed network must explicitly provide their network routing/certificate configuration; the Compose file contains no such host-specific values.

These are explicit one-off jobs; run the data-producing jobs before their consumers:

```bash
docker compose -f compose.research.yml --profile research --profile freqtrade-dry-run --profile cryptofeed-public build
docker compose -f compose.research.yml run --rm research-health
docker compose -f compose.research.yml run --rm market-fetch
docker compose -f compose.research.yml run --rm research-indicators
docker compose -f compose.research.yml run --rm research-backtest
docker compose -f compose.research.yml run --rm research-store
docker compose -f compose.research.yml run --rm freqtrade-validate
docker compose -f compose.research.yml run --rm freqtrade-paper
docker compose -f compose.research.yml run --rm cryptofeed-public
```

For allocation, first fetch another aligned market into the same report volume:

```bash
docker compose -f compose.research.yml run --rm market-fetch fetch --symbol ETH/USDT:USDT --timeframe 1m --count 1000 --out /reports/eth-vst.json
docker compose -f compose.research.yml run --rm research-allocate
```

Minute candles from a short fetch do not provide 30 daily returns. For a dependency-only report smoke using explicitly synthetic daily candles:

```bash
docker compose -f compose.research.yml run --rm research-health fixture --count 500 --interval-ms 86400000 --out /reports/synthetic-daily.json
docker compose -f compose.research.yml run --rm research-backtest backtest /reports/synthetic-daily.json --out /reports/research.json
docker compose -f compose.research.yml run --rm research-report
```

`research-reports` stores exported data and reports; `freqtrade-paper` stores the isolated paper ledger/user directory. The deployment owner can mount the former read-only into a report viewer. `registry.json` provides explicit verification metadata for UI cards; it describes the local checks below, not current deployment health. Docker was unavailable in this workspace: research Compose YAML/context checks passed, but these optional research image builds and container execution are not claimed. The main Node application image has separate successful GitHub Actions build evidence in `VALIDATION.md`.

## Installation and reproducible commands

Run from the repository root. Research Python packages are optional and do not change Node dependencies. Use Python 3.12 to match the tested environments:

```bash
python3.12 -m venv integrations/research/.venv
integrations/research/.venv/bin/python -m pip install -r integrations/research/requirements.txt
integrations/research/.venv/bin/python integrations/research/bridge.py health
```

The version ranges intentionally exclude APScheduler 4 and unsupported major changes; they are not a reproducible dependency lock. `requirements-tested.txt` records the exact Python 3.12/Linux environment used for the adapter tests below; install that file to reproduce that environment. VectorBT 0.28 is kept on Plotly 5 because its templates fail with Plotly 7's removed `scattermapbox` property. Install Freqtrade separately using `requirements-freqtrade.txt`; its dependency set differs from the numerical environment. The bundled Cryptofeed adapter pins release 2.5.0, tested here on Python 3.12.14; its `yapic-json` dependency required `CC=gcc CXX=g++` to build in this environment. Current upstream main has different Python requirements. `requirements-feed-tested.txt` and `requirements-freqtrade-tested.txt` freeze both isolated environments. Dependency installation alone does not establish network/API compatibility.

Dependency-free fixture and contract verification:

```bash
python -m unittest discover -s integrations/research -p 'test_*.py' -v
python integrations/research/bridge.py fixture --count 500 --out integrations/research/output/synthetic.json
python integrations/research/bridge.py validate integrations/research/output/synthetic.json
python integrations/research/freqtrade_dry_run.py --validate-only
```

The fixture is deterministic **synthetic OHLCV**, not market history or performance evidence. Use different seeds for distinct allocation fixture series. Use `--interval-ms 86400000` with at least 500 rows for a daily fixture capable of exercising QuantStats; this remains synthetic data.

With the numerical research dependencies installed:

```bash
integrations/research/.venv/bin/python integrations/research/bridge.py fetch --symbol BTC/USDT:USDT --timeframe 1m --count 1000 --out integrations/research/output/btc-vst.json
integrations/research/.venv/bin/python integrations/research/bridge.py indicators integrations/research/output/btc-vst.json --out integrations/research/output/indicators.json
integrations/research/.venv/bin/python integrations/research/bridge.py backtest integrations/research/output/btc-vst.json --fee-bps 8 --slippage-percent 10 --out integrations/research/output/research.json
integrations/research/.venv/bin/python integrations/research/bridge.py store integrations/research/output/btc-vst.json --database integrations/research/output/research.duckdb
integrations/research/.venv/bin/python integrations/research/bridge.py schedule --symbol BTC/USDT:USDT --count 500 --cycles 3 --seconds 60 --out integrations/research/output/btc-vst.json
```

`--fee-bps 8` is a labeled per-fill research fallback, **not** an assertion of the account's actual fee tier. `--slippage-percent 10` means 10% of that fee per fill. Replace the fee with verified account data when comparing execution. The baseline does not model funding, liquidation, latency, order-book depth, or exact exchange fills.

Allocation accepts two or more aligned candle bundles from the same origin/timeframe:

```bash
integrations/research/.venv/bin/python integrations/research/bridge.py allocate integrations/research/output/btc-vst.json integrations/research/output/eth-vst.json --max-weight 0.6 --out integrations/research/output/weights.json
integrations/research/.venv/bin/python integrations/research/bridge.py report integrations/research/output/research.json --out integrations/research/output/tearsheet.html
node integrations/research/chart.mjs integrations/research/output/btc-vst.json integrations/research/output/chart.html
```

The report command rejects minute-level inputs spanning fewer than 30 daily holdout returns. The chart exporter uses the locally installed `lightweight-charts` package or an explicit third argument pointing to its standalone distribution; it does not download executable code.

Public stream and independent spot comparison, each with a duration bound:

```bash
python integrations/research/feed.py --exchange kraken --symbol BTC-USD --seconds 30 --out integrations/research/output/public-trades.jsonl
python integrations/research/feed.py --self-test --out integrations/research/output/feed-fixture.jsonl
python integrations/research/freqtrade_dry_run.py --seconds 120
```

Run these with the respective isolated environment active. `feed.py --self-test` exercises a real Cryptofeed `Trade` object with labeled synthetic data and no network. Freqtrade `--validate-only` invokes the installed strategy resolver and full dry-run schema validation when the package is available; otherwise it explicitly reports only local invariant checks. The launcher creates its own ignored user-data directory and supplies it to Freqtrade. A bounded feed with no observed messages exits nonzero rather than reporting a connection as verified.

## Interchange and audit contract

Candle bundles use `schemaVersion: 1`, explicit `origin`, `market`, `symbol`, `intervalMs`, and ascending unique millisecond timestamps. Prices must be finite and positive; volume cannot be negative; OHLC bounds are checked. Origins are `synthetic-fixture`, `exchange-vst`, or `exchange-public`. DuckDB keys include origin and market so fixtures cannot overwrite a market series. Each research result carries its source, and candidate selection records the train/holdout boundary. Exported reports do not update production PF, stage samples, balances, or orders.

## Verification status — 10 November 2026

- Nine standard-library contract tests passed, covering duplicate candles, invalid OHLC/NaN/time units, deterministic fixture provenance, atomic file roundtrip, feasible capped allocations, Freqtrade dry-run boundaries, and equity CSV provenance/timezone/fee handling.
- In the fresh repository, **15 tests passed in 28.693 seconds**, with the two separate-environment tests intentionally skipped in that environment. The six numerical adapter checks exercised TA-Lib prefix/causality invariance; VectorBT training selection and 150-observation holdout equity; a real QuantStats HTML report from 149 synthetic daily holdout returns; skfolio capped allocation; idempotent DuckDB storage with separated origins; an APScheduler cycle using a mocked public fetch; and CCXT sandbox URL selection without network calls. Some checks share a test method.
- Installed/tested versions: CCXT 4.5.92, TA-Lib 0.6.8, VectorBT 0.28.5, Plotly 5.24.1, skfolio 0.20.2, DuckDB 1.5.6, QuantStats 0.0.86, APScheduler 3.11.3. `pip check` passed. These are synthetic/offline functional checks, not performance evidence.
- Python compilation, all CLI `--help` paths, 500-row synthetic fixture validation, and bundled Freqtrade config invariants passed.
- The optional Lightweight Charts exporter generated a self-contained HTML file from the labeled synthetic fixture using the locally installed library. Its browser rendering was not tested by this research adapter check; the native UI has a separate validation path.
- An initial CCXT attempt failed because its default transport ignored standard proxy routing. After explicitly honoring network proxies and a configured CA bundle while retaining TLS verification and disabling netrc authentication, an actual VST fetch succeeded: **99 completed BTC/USDT:USDT one-minute candles** from 100 requested rows. A real APScheduler cycle also fetched 99 candles, and correctly skipped an overlapping interval while that job ran. No exchange credentials or order methods were used.
- Two additional isolated adapter tests passed again against the fresh repository with actual dependencies: Freqtrade **2026.10** loaded the strategy, validated the complete dry-run configuration, produced entry and exit signals on a 500-candle synthetic fixture, and preserved exact prefix results when future candles were removed. Cryptofeed **2.5.0** replayed a typed `Trade` object, preserved decimal precision and synthetic provenance, and rejected a negative price. Each test ran in its own isolated Python 3.12.14 environment. Both dependency checks passed. Together with the numerical tests above, **17 distinct tests passed** across the three environments.
- The Node service handoff completed end to end on 91 explicitly synthetic equity snapshots: CSV import, JSON hash/provenance record, and a QuantStats HTML report from 90 daily returns. It did not modify engine state.
- Actual Freqtrade validation exposed and fixed disabled-Telegram fields and user-directory setup. `freqtradeSchemaVerified` is `true` with the installed package; `show-config` succeeded. After explicit Requests/aiohttp proxy and CA routing was added, a **45-second spot dry-run reached RUNNING**, loaded BTC/USDT, ETH/USDT, and SOL/USDT, generated an explicitly simulated BTC buy, emitted a heartbeat, and stopped at its bound with exit code 0. It used an empty NETRC and no exchange keys. This establishes a bounded paper session, not sustained uptime or profitable results.
- A subsequent real **Kraken BTC-USD capture received 20 public trades in 20 seconds** and stopped at its bound. The Coinbase adapter in pinned Cryptofeed 2.5.0 returned HTTP 401 when loading symbol metadata; Kraken is therefore the default and documented runnable example. After explicitly isolating feed configuration and NETRC, a final 15-second capture received another 9 trades. The adapter ignores `CRYPTOFEED_CONFIG` and disables logfile writes into the container application directory. An earlier empty capture correctly returned nonzero. The offline typed-object replay and serialization also succeeded.
- `bridge.py health` reports distribution presence only and deliberately never marks a package runtime-verified from installation metadata.
- The compact `research-network.json` validation record captures actual public-data counts, hashes, and the bounded dry-run evidence. Do not infer x02 fills or profitability from research results.

## Primary documentation reviewed

- [BingX base URLs](https://github.com/BingX-API/api-ai-skills/blob/main/skills/references/base-urls.md), [signing](https://github.com/BingX-API/api-ai-skills/blob/main/skills/references/authentication.md), [market](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/api-reference.md), [account](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-account/api-reference.md), [orders](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md).
- [CCXT BingX sandbox support](https://docs.ccxt.com/docs/comparisons/ccxt-vs-bingx-api), [Freqtrade exchange support](https://docs.freqtrade.io/en/latest/exchanges/).
- [VectorBT signal portfolios](https://vectorbt.dev/api/portfolio/base/), [skfolio optimization](https://skfolio.org/user_guide/optimization.html), [APScheduler 3.x](https://apscheduler.readthedocs.io/en/3.x/userguide.html), [Lightweight Charts attribution](https://tradingview.github.io/lightweight-charts/docs).

