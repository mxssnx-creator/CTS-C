#!/usr/bin/env python3
"""Validate and launch only the bundled spot comparison in Freqtrade dry-run."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def contains_credentials(value):
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = "".join(char for char in str(key).lower() if char.isalnum())
            credential = normalized in {"key", "apikey", "secret", "secretkey", "password", "passphrase",
                                        "uid", "accountid", "privatekey", "token", "accesstoken", "authorization"}
            credential = credential or normalized.endswith(("apikey", "apisecret"))
            if credential and item:
                return True
            if contains_credentials(item):
                return True
    elif isinstance(value, list):
        return any(contains_credentials(item) for item in value)
    return False


def validate_config(config):
    if config.get("dry_run") is not True or config.get("trading_mode") != "spot":
        raise ValueError("Only spot dry-run is supported by this research adapter")
    exchange = config.get("exchange", {})
    if exchange.get("name") != "bingx" or contains_credentials(exchange):
        raise ValueError("This adapter requires a public BingX config without credentials")
    if any(":" in pair for pair in exchange.get("pair_whitelist", [])):
        raise ValueError("Futures pairs are not supported in this Freqtrade adapter")
    if config.get("api_server", {}).get("enabled") or config.get("telegram", {}).get("enabled"):
        raise ValueError("Remote controls must be disabled for isolated comparison")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--seconds", type=int, default=120)
    args = parser.parse_args()
    if not 5 <= args.seconds <= 3600:
        parser.error("--seconds must be 5..3600")
    config = validate_config(json.loads((ROOT / "freqtrade.spot.json").read_text()))
    if args.validate_only:
        verified = False
        try:
            from freqtrade.configuration.config_validation import validate_config_consistency
            from freqtrade.enums import RunMode
            from freqtrade.resolvers import StrategyResolver
        except ImportError:
            pass
        else:
            config.update({"runmode": RunMode.DRY_RUN, "strategy_path": str(ROOT),
                           "user_data_dir": ROOT / "output" / "freqtrade-user"})
            StrategyResolver.load_strategy(config)
            validate_config_consistency(config)
            verified = True
        print(json.dumps({"configInvariants": "passed", "freqtradeSchemaVerified": verified, "mode": "spot-dry-run"}))
        return
    binary = shutil.which("freqtrade")
    if not binary:
        parser.error("Install Freqtrade in its own environment; it is not a core Node dependency")
    output = ROOT / "output"
    output.mkdir(exist_ok=True)
    userdir = output / "freqtrade-user"
    userdir.mkdir(exist_ok=True)
    # Environment config overrides could enable live mode or inject credentials.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("FREQTRADE__")}
    # Honor standard proxy/CA routing while an empty NETRC prevents either
    # Requests or aiohttp from discovering unrelated account credentials.
    ca_bundle = environment.get("REQUESTS_CA_BUNDLE") or environment.get("CURL_CA_BUNDLE")
    for key in ("ccxt_config", "ccxt_async_config"):
        config["exchange"][key]["requests_trust_env"] = True
        config["exchange"][key]["aiohttp_trust_env"] = True
        if ca_bundle:
            config["exchange"][key]["cafile"] = ca_bundle
    if ca_bundle:
        config["exchange"]["ccxt_config"]["validateServerSsl"] = ca_bundle
    with tempfile.TemporaryDirectory(prefix="ctsc-freqtrade-") as directory:
        config_path, netrc_path = Path(directory) / "public-dry-run.json", Path(directory) / "empty-netrc"
        config_path.write_text(json.dumps(validate_config(config)), encoding="utf-8")
        netrc_path.write_text("", encoding="utf-8")
        config_path.chmod(0o600)
        netrc_path.chmod(0o600)
        environment["NETRC"] = str(netrc_path)
        command = [binary, "trade", "--dry-run", "--config", str(config_path),
                   "--strategy-path", str(ROOT), "--strategy", "CTSResearchStrategy",
                   "--userdir", str(userdir),
                   "--db-url", f"sqlite:///{output / 'freqtrade-paper.sqlite'}"]
        try:
            process = subprocess.Popen(command, env=environment, cwd=ROOT)
            try:
                result = process.wait(timeout=args.seconds)
                if result:
                    parser.exit(result, "Freqtrade comparison failed\n")
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        except OSError as exc:
            parser.exit(2, f"Freqtrade could not start: {exc}\n")


if __name__ == "__main__":
    main()
