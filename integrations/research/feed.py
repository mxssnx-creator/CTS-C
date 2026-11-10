#!/usr/bin/env python3
"""Bounded Cryptofeed public trade capture, separate from x02 execution."""
import argparse
import json
import math
import multiprocessing
import os
from pathlib import Path
import tempfile


def append_trade(trade, receipt_timestamp, output, origin="exchange-public"):
    if origin not in ("exchange-public", "synthetic-fixture"):
        raise ValueError("Unknown feed provenance")
    if not trade.price.is_finite() or not trade.amount.is_finite() or trade.price <= 0 or trade.amount < 0:
        raise ValueError("Invalid normalized trade price or amount")
    timestamp = trade.timestamp if trade.timestamp is not None else receipt_timestamp
    if not math.isfinite(timestamp) or not math.isfinite(receipt_timestamp):
        raise ValueError("Invalid feed timestamp")
    value = {"schemaVersion": 1, "origin": origin, "event": "trade",
             "exchange": trade.exchange, "symbol": trade.symbol,
             "id": str(trade.id) if trade.id is not None else None,
             "timestamp": timestamp, "receivedAt": receipt_timestamp,
             "price": str(trade.price), "amount": str(trade.amount), "side": trade.side}
    with Path(output).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, allow_nan=False) + "\n")
    return value


def capture(exchange, symbol, output):
    from cryptofeed import FeedHandler
    from cryptofeed.defines import TRADES
    from cryptofeed.exchanges import Coinbase, Kraken

    async def on_trade(trade, receipt_timestamp):
        append_trade(trade, receipt_timestamp, output)

    # Explicit config avoids CRYPTOFEED_CONFIG account imports and logfile
    # writes into the read-only container application directory.
    public_config = {"uvloop": True, "log": {"disabled": True}}
    with tempfile.TemporaryDirectory(prefix="ctsc-public-feed-") as directory:
        netrc = Path(directory) / "empty-netrc"
        netrc.write_text("", encoding="utf-8")
        netrc.chmod(0o600)
        os.environ["NETRC"] = str(netrc)  # This is the isolated child process.
        handler = FeedHandler(config=public_config)
        venue = {"coinbase": Coinbase, "kraken": Kraken}[exchange]
        handler.add_feed(venue(symbols=[symbol], channels=[TRADES], callbacks={TRADES: on_trade}, config=public_config))
        handler.run()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exchange", choices=["coinbase", "kraken"], default="kraken")
    parser.add_argument("--symbol", default="BTC-USD")
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--out", required=True)
    parser.add_argument("--self-test", action="store_true", help="Replay one labeled synthetic Cryptofeed Trade object; no network")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600:
        parser.error("--seconds must be 1..600")
    try:
        import cryptofeed  # noqa: F401
    except ImportError:
        parser.error("Cryptofeed is optional; install requirements-feed.txt in a compatible separate environment")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    if args.self_test:
        from decimal import Decimal
        from cryptofeed.types import Trade
        from cryptofeed.defines import BUY
        trade = Trade("COINBASE", "BTC-USD", BUY, Decimal("0.1"), Decimal("100"),
                      1735689600.0, id="synthetic-1")
        value = append_trade(trade, 1735689600.01, args.out, "synthetic-fixture")
        print(json.dumps({"ok": True, "mode": "offline-adapter-replay", "origin": value["origin"],
                          "capturedMessages": 1, "output": args.out, "orderPlacement": False}))
        return
    def line_count():
        if not Path(args.out).exists():
            return 0
        with Path(args.out).open(encoding="utf-8") as stream:
            return sum(1 for _ in stream)
    previous_count = line_count()
    worker = multiprocessing.get_context("spawn").Process(target=capture, args=(args.exchange, args.symbol, args.out))
    worker.start()
    worker.join(args.seconds)
    bounded_stop = worker.is_alive()
    if bounded_stop:
        worker.terminate()
        worker.join(5)
        if worker.is_alive():
            worker.kill()
            worker.join()
    if not bounded_stop and worker.exitcode:
        parser.exit(2, "Cryptofeed capture failed; no execution integration was invoked\n")
    count = line_count() - previous_count
    print(json.dumps({"ok": count > 0, "output": args.out, "durationLimitSeconds": args.seconds,
                      "capturedMessages": count, "boundedStop": bounded_stop, "orderPlacement": False}))
    if count == 0:
        parser.exit(2, "No public feed messages observed within the duration limit\n")


if __name__ == "__main__":
    main()
