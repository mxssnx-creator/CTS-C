#!/usr/bin/env python3
"""Read-only CTS-C research adapters. No function submits exchange orders.

The JSON interchange contract is independent of optional numerical packages.
All generated fixtures are labeled synthetic. Research results never modify
the Node engine's settings, gates, account balance, or execution records.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
import random
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import getproxies, proxy_bypass

MODULES = {"ccxt": "ccxt", "talib": "TA-Lib", "vectorbt": "vectorbt",
           "skfolio": "skfolio", "duckdb": "duckdb", "quantstats": "quantstats",
           "apscheduler": "APScheduler", "cryptofeed": "cryptofeed"}
MAX_CANDLES = 100_000


def require(name: str):
    try:
        return importlib.import_module(name)
    except ImportError as exc:
        raise ValueError(f"Optional dependency {name} unavailable; install research requirements in a separate virtual environment") from exc


def write_json(path: str | Path, value: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, allow_nan=False) + "\n"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def validate_bundle(value: Any) -> dict:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("Expected candle bundle schemaVersion 1")
    if value.get("market") not in ("spot", "swap"):
        raise ValueError("market must be spot or swap")
    if not isinstance(value.get("symbol"), str) or not value["symbol"]:
        raise ValueError("symbol required")
    if value.get("origin") not in ("synthetic-fixture", "exchange-vst", "exchange-public"):
        raise ValueError("Explicit origin required")
    interval = value.get("intervalMs")
    if isinstance(interval, bool) or not isinstance(interval, int) or not 1000 <= interval <= 31_536_000_000:
        raise ValueError("intervalMs must be a positive integer candle duration")
    candles = value.get("candles")
    if not isinstance(candles, list) or not 2 <= len(candles) <= MAX_CANDLES:
        raise ValueError(f"Expected 2..{MAX_CANDLES} candles")
    previous = -1
    for row in candles:
        if not isinstance(row, dict):
            raise ValueError("Candle must be an object")
        timestamp = row.get("timestamp")
        if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp <= previous:
            raise ValueError("Timestamps must be ascending unique Unix milliseconds")
        if timestamp < 1_000_000_000_000:
            raise ValueError("Timestamp must be milliseconds, not seconds")
        previous = timestamp
        for key in ("open", "high", "low", "close", "volume"):
            number = row.get(key)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                raise ValueError(f"Non-finite or missing candle {key}")
            if number < 0 or (key != "volume" and number == 0):
                raise ValueError(f"Invalid candle {key}")
        if row["low"] > min(row["open"], row["close"]) or row["high"] < max(row["open"], row["close"]):
            raise ValueError("OHLC high/low bounds invalid")
    return value


def load_bundle(path: str | Path) -> dict:
    return validate_bundle(json.loads(Path(path).read_text(encoding="utf-8")))


def fixture(symbol="BTC/USDT:USDT", count=500, seed=73, interval_ms=60_000) -> dict:
    if not 2 <= count <= MAX_CANDLES or interval_ms < 1000:
        raise ValueError("Invalid fixture bounds")
    rng = random.Random(seed)
    price = 100.0
    rows = []
    for i in range(count):
        opening = price
        price *= math.exp(rng.gauss(0, 0.006) + math.sin(i / 17) * 0.001)
        spread = rng.uniform(0.001, 0.008)
        rows.append({"timestamp": 1_735_689_600_000 + i * interval_ms,
                     "open": opening, "high": max(opening, price) * (1 + spread),
                     "low": min(opening, price) * (1 - spread), "close": price,
                     "volume": rng.uniform(20, 200)})
    return validate_bundle({"schemaVersion": 1, "origin": "synthetic-fixture", "market": "swap",
                            "symbol": symbol, "intervalMs": interval_ms, "candles": rows})


def frame(bundle: dict):
    pd = require("pandas")
    df = pd.DataFrame(bundle["candles"])
    df.index = pd.to_datetime(df.pop("timestamp"), unit="ms", utc=True)
    return df


def finite(value):
    number = float(value)
    return number if math.isfinite(number) else None


def indicators(bundle: dict) -> dict:
    ta = require("talib")
    df = frame(bundle)
    close = df["close"].to_numpy(dtype="float64")
    macd, signal, histogram = ta.MACD(close)
    arrays = {"rsi14": ta.RSI(close, timeperiod=14), "ema12": ta.EMA(close, timeperiod=12),
              "ema26": ta.EMA(close, timeperiod=26), "macd": macd, "macdSignal": signal,
              "macdHistogram": histogram,
              "atr14": ta.ATR(df["high"].to_numpy(), df["low"].to_numpy(), close, timeperiod=14)}
    return {"schemaVersion": 1, "origin": bundle["origin"], "symbol": bundle["symbol"],
            "engine": "TA-Lib", "warmup": "null until the indicator has enough past observations",
            "rows": [{"timestamp": row["timestamp"], **{name: finite(values[i]) for name, values in arrays.items()}}
                     for i, row in enumerate(bundle["candles"])]}


def backtest(bundle: dict, fee_bps: float, slippage_percent: float) -> dict:
    """Independent EMA candidates; train selection precedes untouched holdout.

    Indicators use closed candles, signals execute at the next candle's open.
    This research benchmark is not a clone of the CTS stage/Axis/Block/DCA engine.
    """
    if not 0 <= fee_bps <= 100 or not 0 <= slippage_percent <= 100:
        raise ValueError("Fee/slippage inputs out of bounds")
    vbt = require("vectorbt")
    df = frame(bundle)
    if len(df) < 200:
        raise ValueError("At least 200 candles required for training and holdout")
    split = int(len(df) * 0.7)
    fee = fee_bps / 10_000
    slip = fee * slippage_percent / 100
    candidates = []
    portfolios = {}
    for fast in (5, 10, 20):
        for slow in (21, 34, 55):
            f = df.close.ewm(span=fast, adjust=False, min_periods=fast).mean()
            s = df.close.ewm(span=slow, adjust=False, min_periods=slow).mean()
            entries = ((f > s) & (f.shift() <= s.shift())).shift(1, fill_value=False)
            exits = ((f < s) & (f.shift() >= s.shift())).shift(1, fill_value=False)
            key = f"ema-{fast}-{slow}"
            results = {}
            for label, region in (("train", slice(None, split)), ("holdout", slice(split, None))):
                part = df.iloc[region]
                pf = vbt.Portfolio.from_signals(
                    part.close, entries.iloc[region], exits.iloc[region], price=part.open,
                    init_cash=10_000, size=0.1, size_type="percent", direction="longonly",
                    fees=fee, slippage=slip, cash_sharing=False,
                    freq=f"{bundle['intervalMs']}ms",
                )
                results[label] = {"totalReturn": finite(pf.total_return()),
                                  "maxDrawdown": finite(pf.max_drawdown()),
                                  "closedTrades": int(pf.trades.closed.count()),
                                  "openTrades": int(pf.trades.open.count()),
                                  "feesPaid": finite(pf.orders.records["fees"].sum())}
                if label == "holdout":
                    portfolios[key] = pf
            candidates.append({"id": key, "fast": fast, "slow": slow, **results})
    selected = max(candidates, key=lambda c: c["train"]["totalReturn"] if c["train"]["totalReturn"] is not None else -math.inf)
    equity = portfolios[selected["id"]].value()
    return {"schemaVersion": 1, "kind": "research-only", "origin": bundle["origin"], "symbol": bundle["symbol"],
            "engine": "vectorbt", "execution": "next-open; independent long-only EMA baseline",
            "selectedOn": "training total return only", "selectedId": selected["id"],
            "splitTimestamp": bundle["candles"][split]["timestamp"], "feeBpsPerFill": fee_bps,
            "slippagePercentOfFee": slippage_percent, "candidates": candidates,
            "holdoutEquity": [{"timestamp": int(t.timestamp() * 1000), "equity": float(v)} for t, v in equity.items()],
            "autoApplied": False}


def capped_weights(weights: list[float], cap: float) -> list[float]:
    if not weights or not math.isfinite(cap) or not 0 < cap <= 1 or len(weights) * cap < 1 - 1e-10:
        raise ValueError("Weight cap is infeasible for the number of assets")
    if any(not math.isfinite(w) or w < 0 for w in weights) or sum(weights) <= 0:
        raise ValueError("Weights must be finite nonnegative with a positive total")
    output = [0.0] * len(weights)
    remaining = set(range(len(weights)))
    budget = 1.0
    while remaining:
        total = sum(weights[i] for i in remaining)
        proposed = {i: budget * (weights[i] / total if total else 1 / len(remaining)) for i in remaining}
        overflowing = [i for i, value in proposed.items() if value > cap + 1e-12]
        if not overflowing:
            for i, value in proposed.items():
                output[i] = value
            break
        for i in overflowing:
            output[i] = cap
            budget -= cap
            remaining.remove(i)
    return output


def allocate(bundles: list[dict], cap: float) -> dict:
    pd = require("pandas")
    require("skfolio")
    from skfolio.optimization import InverseVolatility
    symbols = [b["symbol"] for b in bundles]
    if len(set(symbols)) != len(symbols):
        raise ValueError("Allocation requires distinct symbols")
    if len({b["origin"] for b in bundles}) != 1 or len({b.get("intervalMs") for b in bundles}) != 1:
        raise ValueError("Do not combine different origins or timeframes")
    close = pd.concat([frame(b).close.rename(b["symbol"]) for b in bundles], axis=1, join="inner")
    returns = close.pct_change(fill_method=None).dropna()
    if len(returns) < 60 or (returns.std() <= 1e-12).any():
        raise ValueError("Need at least 60 aligned nonconstant returns per asset")
    split = int(len(returns) * 0.7)
    estimator = InverseVolatility().fit(returns.iloc[:split])
    weights = capped_weights([float(v) for v in estimator.weights_], cap)
    held = returns.iloc[split:].dot(weights)
    return {"schemaVersion": 1, "kind": "research-only", "engine": "skfolio InverseVolatility",
            "origin": bundles[0]["origin"], "trainedSamples": split,
            "holdoutSamples": len(held), "weightCap": cap, "weights": dict(zip(symbols, weights)),
            "holdoutGrossReturn": float((1 + held).prod() - 1),
            "costsIncluded": False, "autoApplied": False}


def store_bundle(bundle: dict, database: str) -> dict:
    duckdb = require("duckdb")
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(database)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS candles (origin VARCHAR, market VARCHAR, symbol VARCHAR, timestamp BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, PRIMARY KEY(origin, market, symbol, timestamp))")
        con.execute("BEGIN TRANSACTION")
        con.executemany("INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", [
            (bundle["origin"], bundle["market"], bundle["symbol"], row["timestamp"], row["open"], row["high"], row["low"], row["close"], row["volume"])
            for row in bundle["candles"]])
        con.execute("COMMIT")
        count = con.execute("SELECT count(*) FROM candles WHERE origin=? AND market=? AND symbol=?", [bundle["origin"], bundle["market"], bundle["symbol"]]).fetchone()[0]
        return {"database": database, "rowsForSeries": count, "idempotency": "origin/market/symbol/timestamp"}
    finally:
        con.close()


def fetch_candles(symbol: str, timeframe: str, count: int) -> dict:
    if not 2 <= count <= 1440:
        raise ValueError("Fetch limit must be 2..1440")
    ccxt = require("ccxt")
    # CCXT disables Requests' environment trust by default. Forward only
    # standard proxy routing explicitly, without enabling netrc credentials.
    proxies = {} if proxy_bypass("open-api-vst.bingx.com") else {
        key: value for key, value in getproxies().items() if key in ("http", "https", "all")
    }
    # CCXT forwards validateServerSsl to Requests' verify argument. A supplied
    # CA bundle retains TLS verification on managed networks; never use False.
    ca_bundle = os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("CURL_CA_BUNDLE")
    exchange = ccxt.bingx({"enableRateLimit": True, "timeout": 15_000,
                          "proxies": proxies, "validateServerSsl": ca_bundle or True,
                          "options": {"defaultType": "swap"}})
    exchange.set_sandbox_mode(True)  # Set before the first network call. No API keys.
    interval = exchange.parse_timeframe(timeframe) * 1000
    now = exchange.milliseconds()
    try:
        rows = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=count)
    except ccxt.BaseError as exc:
        raise ValueError(f"BingX VST public data request failed ({type(exc).__name__}); no synthetic fallback was used") from exc
    finally:
        exchange.close()
    # The newest candle can still be changing. Research only sees completed candles.
    candles = [{"timestamp": int(t), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v)}
               for t, o, h, l, c, v in rows if t + interval <= now]
    return validate_bundle({"schemaVersion": 1, "origin": "exchange-vst", "market": "swap",
                            "symbol": symbol, "intervalMs": interval, "candles": candles})


def quantstats_report(path: str, output: str) -> dict:
    qs, pd = require("quantstats"), require("pandas")
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    if report.get("kind") == "research-only":
        rows = report.get("holdoutEquity")
    elif report.get("kind") == "ledger-equity-import":
        rows = report.get("equitySnapshots")
    else:
        rows = None
    if not rows:
        raise ValueError("Expected a bridge backtest report or explicit ledger-equity import")
    equity = pd.Series([row["equity"] for row in rows], index=pd.to_datetime([row["timestamp"] for row in rows], unit="ms", utc=True))
    daily = equity.resample("1D").last().ffill().pct_change(fill_method=None).dropna()
    if len(daily) < 30:
        raise ValueError("QuantStats report requires at least 30 daily equity returns; intraday trades are not daily returns")
    daily.index = daily.index.tz_localize(None)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    qs.reports.html(daily, benchmark=None, output=output, periods_per_year=365,
                    title=f"CTS-C equity returns / {report['origin']} / {report.get('symbol', report.get('account', 'import'))}")
    return {"output": output, "dailyReturns": len(daily),
            "dailyHoldoutReturns": len(daily) if report["kind"] == "research-only" else None, "benchmark": None}


def import_equity_csv(path: str, time_column: str, equity_column: str, origin: str, account: str) -> dict:
    """Import explicit engine equity snapshots; never reconstruct cash from fills.

    Costs/funding already included in supplied equity are not deducted again.
    This format makes no claim that reported equity has been exchange-reconciled.
    """
    if origin not in ("engine-paper", "engine-vst", "engine-mainnet", "imported-unverified", "synthetic-fixture"):
        raise ValueError("An explicit supported ledger origin is required")
    path_obj = Path(path)
    raw = path_obj.read_bytes()
    rows = []
    previous = -1
    with path_obj.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or not {time_column, equity_column}.issubset(reader.fieldnames):
            raise ValueError("CSV must contain the selected timestamp and equity columns")
        for row in reader:
            if len(rows) >= MAX_CANDLES:
                raise ValueError("Equity CSV exceeds the 100000-row research limit")
            raw_time = (row.get(time_column) or "").strip()
            if raw_time.isdigit():
                timestamp = int(raw_time)
                if timestamp < 1_000_000_000_000:
                    raise ValueError("Numeric ledger timestamps must be Unix milliseconds")
            else:
                parsed = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("ISO ledger timestamps require an explicit timezone")
                timestamp = int(parsed.timestamp() * 1000)
            value = float(row.get(equity_column) or "")
            if timestamp <= previous or not math.isfinite(value) or value <= 0:
                raise ValueError("Equity snapshots require ascending unique timestamps and positive finite equity")
            rows.append({"timestamp": timestamp, "equity": value})
            previous = timestamp
    if len(rows) < 2:
        raise ValueError("At least two equity snapshots are required")
    return {"schemaVersion": 1, "kind": "ledger-equity-import", "origin": origin, "account": account,
            "provenanceDeclaredByImporter": True, "exchangeReconciliationVerified": False,
            "sourceSha256": hashlib.sha256(raw).hexdigest(),
            "equityBasis": "supplied snapshots; no additional fee/funding deductions",
            "equitySnapshots": rows, "autoApplied": False}


def schedule_fetch(symbol: str, timeframe: str, count: int, output: str, cycles: int, seconds: int) -> dict:
    if not 1 <= cycles <= 100 or not 5 <= seconds <= 3600:
        raise ValueError("Schedule must have 1..100 cycles and 5..3600 second interval")
    require("apscheduler")
    from apscheduler.schedulers.background import BackgroundScheduler
    stop = threading.Event()
    results = []
    scheduler = BackgroundScheduler(timezone="UTC")

    def job():
        if len(results) >= cycles:
            return
        try:
            value = fetch_candles(symbol, timeframe, count)
            write_json(output, value)
            results.append({"ok": True, "rows": len(value["candles"])})
        except Exception as exc:
            # No secrets exist in this public-data adapter; only error type is recorded.
            results.append({"ok": False, "errorType": type(exc).__name__})
        if len(results) >= cycles:
            stop.set()

    scheduler.add_job(job, "interval", seconds=seconds, max_instances=1, coalesce=True,
                      next_run_time=datetime.now(timezone.utc))
    scheduler.start()
    try:
        stop.wait(cycles * max(seconds, 120) + 30)
    finally:
        scheduler.shutdown(wait=True)
    return {"cycles": results, "completed": len(results) == cycles}


def health() -> dict:
    status = {}
    for module, distribution in MODULES.items():
        try:
            version = importlib.metadata.version(distribution)
            status[module] = {"installedVersion": version, "runtimeVerified": False}
        except importlib.metadata.PackageNotFoundError:
            status[module] = {"installedVersion": None, "runtimeVerified": False}
    return {"adapters": status, "orderPlacement": False}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health", help="Report optional dependency installation, never claim execution")
    f = sub.add_parser("fixture", help="Write explicitly synthetic OHLCV")
    f.add_argument("--symbol", default="BTC/USDT:USDT")
    f.add_argument("--count", type=int, default=500)
    f.add_argument("--seed", type=int, default=73)
    f.add_argument("--interval-ms", type=int, default=60_000)
    f.add_argument("--out", required=True)
    for name in ("validate", "indicators", "backtest", "store"):
        p = sub.add_parser(name)
        p.add_argument("input")
        if name in ("indicators", "backtest"):
            p.add_argument("--out", required=True)
        if name == "backtest":
            p.add_argument("--fee-bps", type=float, default=8, help="Per-fill fallback, not exchange-verified")
            p.add_argument("--slippage-percent", type=float, default=10, help="Percent of fee per fill")
        if name == "store":
            p.add_argument("--database", required=True)
    for name in ("fetch", "schedule"):
        p = sub.add_parser(name, help="Public BingX VST completed candles; never private orders")
        p.add_argument("--symbol", default="BTC/USDT:USDT")
        p.add_argument("--timeframe", default="1m")
        p.add_argument("--count", type=int, default=500)
        p.add_argument("--out", required=True)
        if name == "schedule":
            p.add_argument("--cycles", type=int, default=3)
            p.add_argument("--seconds", type=int, default=60)
    p = sub.add_parser("allocate")
    p.add_argument("inputs", nargs="+")
    p.add_argument("--max-weight", type=float, default=0.5)
    p.add_argument("--out", required=True)
    p = sub.add_parser("report", help="QuantStats from daily research or imported engine equity returns")
    p.add_argument("input")
    p.add_argument("--out", required=True)
    p = sub.add_parser("ledger-csv", help="Import fresh Node engine equity snapshots; does not infer equity from trade PnL")
    p.add_argument("input")
    p.add_argument("--time-column", default="timestamp")
    p.add_argument("--equity-column", default="equity")
    p.add_argument("--origin", choices=["engine-paper", "engine-vst", "engine-mainnet", "imported-unverified", "synthetic-fixture"], required=True)
    p.add_argument("--account", default="x02")
    p.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            result = health()
        elif args.command == "fixture":
            result = fixture(args.symbol, args.count, args.seed, args.interval_ms)
            write_json(args.out, result)
        elif args.command == "fetch":
            result = fetch_candles(args.symbol, args.timeframe, args.count)
            write_json(args.out, result)
        elif args.command == "schedule":
            result = schedule_fetch(args.symbol, args.timeframe, args.count, args.out, args.cycles, args.seconds)
        elif args.command == "allocate":
            result = allocate([load_bundle(path) for path in args.inputs], args.max_weight)
            write_json(args.out, result)
        elif args.command == "report":
            result = quantstats_report(args.input, args.out)
        elif args.command == "ledger-csv":
            result = import_equity_csv(args.input, args.time_column, args.equity_column, args.origin, args.account)
            write_json(args.out, result)
        else:
            bundle = load_bundle(args.input)
            if args.command == "validate":
                result = {"valid": True, "origin": bundle["origin"], "rows": len(bundle["candles"])}
            elif args.command == "indicators":
                result = indicators(bundle)
                write_json(args.out, result)
            elif args.command == "backtest":
                result = backtest(bundle, args.fee_bps, args.slippage_percent)
                write_json(args.out, result)
            else:
                result = store_bundle(bundle, args.database)
        # Avoid dumping potentially large market data into logs.
        success = args.command != "schedule" or (result["completed"] and all(cycle["ok"] for cycle in result["cycles"]))
        print(json.dumps({"ok": success, "command": args.command, "output": getattr(args, "out", None),
                          "result": result if args.command in ("health", "validate", "store", "schedule", "report") else {"origin": result.get("origin"), "autoApplied": False}}, allow_nan=False))
        return 0 if success else 2
    except (ValueError, OSError) as exc:
        parser.exit(2, f"research adapter: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
