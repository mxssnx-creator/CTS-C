"""Run separately in the Freqtrade and Cryptofeed environments; no network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from bridge import fixture
from feed import append_trade
from freqtrade_dry_run import validate_config


class ExternalAdapterTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("freqtrade"), "optional Freqtrade environment")
    def test_freqtrade_schema_and_causal_strategy_with_actual_dependencies(self):
        import pandas as pd
        from freqtrade.configuration.config_validation import validate_config_consistency
        from freqtrade.enums import RunMode
        from freqtrade.resolvers import StrategyResolver
        root = Path(__file__).parent
        config = validate_config(json.loads((root / "freqtrade.spot.json").read_text()))
        with tempfile.TemporaryDirectory() as directory:
            config.update({"runmode": RunMode.DRY_RUN, "strategy_path": str(root.resolve()),
                           "user_data_dir": Path(directory)})
            strategy = StrategyResolver.load_strategy(config)
            validate_config_consistency(config)
            bundle = fixture(count=500)
            data = pd.DataFrame(bundle["candles"])
            data["date"] = pd.to_datetime(data.pop("timestamp"), unit="ms", utc=True)

            def evaluate(frame):
                frame = strategy.advise_indicators(frame.copy(), {"pair": "BTC/USDT"})
                frame = strategy.advise_entry(frame, {"pair": "BTC/USDT"})
                return strategy.advise_exit(frame, {"pair": "BTC/USDT"})

            full, prefix = evaluate(data), evaluate(data.iloc[:400])
            pd.testing.assert_frame_equal(full.iloc[:400], prefix)
            self.assertGreater(int(full.enter_long.sum()), 0)
            self.assertGreater(int(full.exit_long.sum()), 0)
            self.assertFalse(strategy.can_short)

    @unittest.skipUnless(importlib.util.find_spec("cryptofeed"), "optional Cryptofeed environment")
    def test_cryptofeed_typed_replay_preserves_decimals_and_origin(self):
        from decimal import Decimal
        from cryptofeed.types import Trade
        from cryptofeed.defines import BUY
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "replay.jsonl"
            trade = Trade("COINBASE", "BTC-USD", BUY, Decimal("0.00000001"), Decimal("12345.12345678"),
                          1735689600.0, id="synthetic-1")
            value = append_trade(trade, 1735689600.01, output, "synthetic-fixture")
            self.assertEqual(value["price"], "12345.12345678")
            self.assertEqual(value["amount"], "1E-8")
            self.assertEqual(json.loads(output.read_text())["origin"], "synthetic-fixture")
            bad = Trade("COINBASE", "BTC-USD", BUY, Decimal("1"), Decimal("-1"),
                        1735689600.0, id="synthetic-2")
            with self.assertRaises(ValueError):
                append_trade(bad, 1735689600.01, output, "synthetic-fixture")


if __name__ == "__main__":
    unittest.main()
