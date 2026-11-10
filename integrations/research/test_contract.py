import copy
import json
from pathlib import Path
import tempfile
import unittest

from bridge import capped_weights, fixture, import_equity_csv, load_bundle, validate_bundle, write_json
from freqtrade_dry_run import validate_config


class ContractTests(unittest.TestCase):
    def test_fixture_is_reproducible_and_explicit(self):
        first = fixture(count=80)
        self.assertEqual(first, fixture(count=80))
        self.assertEqual(first["origin"], "synthetic-fixture")
        self.assertNotEqual(first, fixture(count=80, seed=74))

    def test_duplicate_and_out_of_order_candles_are_rejected(self):
        value = fixture(count=3)
        value["candles"][1]["timestamp"] = value["candles"][0]["timestamp"]
        with self.assertRaises(ValueError):
            validate_bundle(value)

    def test_nan_invalid_prices_seconds_and_ohlc_are_rejected(self):
        for field, invalid in (("close", float("nan")), ("volume", -1), ("open", 0), ("high", 1), ("timestamp", 1735689600)):
            value = fixture(count=3)
            value["candles"][0][field] = invalid
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_bundle(value)

    def test_disk_roundtrip_and_idempotent_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candles.json"
            value = fixture(count=3)
            write_json(path, value)
            self.assertEqual(load_bundle(path), value)
            write_json(path, value)
            self.assertEqual(load_bundle(path), value)

    def test_capped_allocation_conserves_one_and_respects_cap(self):
        result = capped_weights([0.99, 0.009, 0.001], 0.5)
        self.assertAlmostEqual(sum(result), 1)
        self.assertLessEqual(max(result), 0.5)
        self.assertGreaterEqual(min(result), 0)
        self.assertEqual(capped_weights([1, 0, 0], 0.5), [0.5, 0.25, 0.25])

    def test_infeasible_or_nonfinite_weights_fail(self):
        for weights, cap in (([1, 1], .3), ([float("nan"), 1], 1), ([0, 0], 1)):
            with self.assertRaises(ValueError):
                capped_weights(weights, cap)

    def test_freqtrade_cannot_be_configured_as_second_live_executor(self):
        config = json.loads((Path(__file__).parent / "freqtrade.spot.json").read_text())
        validate_config(config)
        for key, value in (("dry_run", False), ("trading_mode", "futures")):
            changed = copy.deepcopy(config)
            changed[key] = value
            with self.assertRaises(ValueError):
                validate_config(changed)
        for injected in ({"key": "not-a-real-key"}, {"apiKey": "not-a-real-key"},
                         {"api_key": "not-a-real-key"}, {"accountId": "not-an-account"},
                         {"ccxt_config": {"secret": "not-a-real-secret"}},
                         {"ccxt_async_config": {"headers": {"X-BX-APIKEY": "not-a-real-key"}}}):
            changed = copy.deepcopy(config)
            changed["exchange"].update(injected)
            with self.assertRaises(ValueError):
                validate_config(changed)

    def test_ledger_csv_import_preserves_supplied_net_equity_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "equity.csv"
            path.write_text("timestamp,equity,fees\n2026-11-01T00:00:00Z,1000,1\n2026-11-02T00:00:00Z,999,2\n")
            result = import_equity_csv(str(path), "timestamp", "equity", "engine-vst", "x02")
            self.assertEqual([r["equity"] for r in result["equitySnapshots"]], [1000, 999])
            self.assertFalse(result["exchangeReconciliationVerified"])
            self.assertEqual(len(result["sourceSha256"]), 64)

    def test_ledger_csv_rejects_ambiguous_timezone_nonfinite_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "equity.csv"
            for body in ("2026-11-01T00:00:00,1000\n2026-11-02T00:00:00,999\n",
                         "1735689600000,1000\n1735689600000,999\n",
                         "1735689600000,1000\n1735776000000,NaN\n"):
                path.write_text("timestamp,equity\n" + body)
                with self.assertRaises(ValueError):
                    import_equity_csv(str(path), "timestamp", "equity", "engine-vst", "x02")


if __name__ == "__main__":
    unittest.main()
