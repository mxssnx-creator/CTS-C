"""Optional integration tests use synthetic input only; never exchange orders."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge import allocate, backtest, fixture, indicators, quantstats_report, schedule_fetch, store_bundle, write_json


def installed(name):
    return importlib.util.find_spec(name) is not None


class OptionalAdapterTests(unittest.TestCase):
    @unittest.skipUnless(installed("talib"), "optional TA-Lib not installed")
    def test_indicators_do_not_depend_on_future_candles(self):
        full = fixture(count=250)
        prefix = {**full, "candles": full["candles"][:200]}
        self.assertEqual(indicators(full)["rows"][:200], indicators(prefix)["rows"])
        self.assertIsNone(indicators(full)["rows"][0]["rsi14"])

    @unittest.skipUnless(installed("vectorbt"), "optional VectorBT not installed")
    def test_train_selection_holdout_and_daily_report(self):
        bundle = fixture(count=500, interval_ms=86_400_000)
        result = backtest(bundle, 8, 10)
        self.assertEqual(len(result["candidates"]), 9)
        self.assertEqual(result["selectedId"], max(result["candidates"], key=lambda c: c["train"]["totalReturn"])["id"])
        self.assertEqual(len(result["holdoutEquity"]), 150)
        self.assertFalse(result["autoApplied"])
        if installed("quantstats"):
            with tempfile.TemporaryDirectory() as directory:
                input_path, output_path = Path(directory) / "research.json", Path(directory) / "report.html"
                write_json(input_path, result)
                report = quantstats_report(str(input_path), str(output_path))
                self.assertEqual(report["dailyHoldoutReturns"], 149)
                self.assertGreater(output_path.stat().st_size, 1000)

    @unittest.skipUnless(installed("skfolio"), "optional skfolio not installed")
    def test_allocation_limits_and_provenance(self):
        result = allocate([fixture("BTC/USDT:USDT", seed=1), fixture("ETH/USDT:USDT", seed=2)], .6)
        self.assertAlmostEqual(sum(result["weights"].values()), 1)
        self.assertLessEqual(max(result["weights"].values()), .6)
        self.assertEqual(result["origin"], "synthetic-fixture")
        self.assertFalse(result["costsIncluded"])

    @unittest.skipUnless(installed("duckdb"), "optional DuckDB not installed")
    def test_storage_deduplicates_and_separates_origins(self):
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "research.duckdb")
            bundle = fixture(count=50)
            self.assertEqual(store_bundle(bundle, database)["rowsForSeries"], 50)
            self.assertEqual(store_bundle(bundle, database)["rowsForSeries"], 50)
            other = {**bundle, "origin": "exchange-vst"}
            self.assertEqual(store_bundle(other, database)["rowsForSeries"], 50)

    @unittest.skipUnless(installed("apscheduler"), "optional APScheduler not installed")
    def test_scheduler_finishes_one_nonoverlapping_cycle(self):
        with tempfile.TemporaryDirectory() as directory, patch("bridge.fetch_candles", return_value=fixture(count=5)) as fetch:
            result = schedule_fetch("BTC/USDT:USDT", "1m", 5, str(Path(directory) / "candles.json"), 1, 5)
            self.assertTrue(result["completed"])
            self.assertEqual(fetch.call_count, 1)

    @unittest.skipUnless(installed("ccxt"), "optional CCXT not installed")
    def test_ccxt_sandbox_host_selection_without_network(self):
        import ccxt
        exchange = ccxt.bingx({"enableRateLimit": True, "options": {"defaultType": "swap"}})
        exchange.set_sandbox_mode(True)
        self.assertIn("open-api-vst.bingx.com", json.dumps(exchange.urls["api"]).replace("{hostname}", exchange.hostname))
        self.assertFalse(exchange.apiKey)
        self.assertFalse(exchange.secret)


if __name__ == "__main__":
    unittest.main()
