# Repeat simulation — 10 November 2026

These are retrospective paper results, not actual venue execution PF. The same six observed seven-day symbol series, per-symbol commission inputs and frozen training selections were reused. The first 65% supplies parameter selection and stage history. Training positions are discarded at the boundary; the remaining 35% starts fresh positions and retains all subsequent losses. No exchange orders were submitted by these scripts. Repeated study of this period limits its value as future validation.

| Frozen selection | Stage policy | Main closes / PF | Real closes / PF | Modeled execution closes / PF | Modeled execution actions |
| --- | --- | --- | --- | --- | --- |
| Core, 24 configs | Continuous ancestors | 342 / 1.5202 | 111 / 2.3997 | 11 / 15.3127 | 22 |
| Core, 24 configs | Independent processed sets | 2,946 / 0.5572 | 2,686 / 0.5041 | 336 / 0.8181 | 717 |
| Expanded, 31 configs | Continuous ancestors | 368 / 1.4493 | 111 / 2.3997 | 11 / 15.3127 | 22 |
| Expanded, 31 configs | Independent processed sets | 3,005 / 0.5595 | 2,686 / 0.5041 | 336 / 0.8181 | 717 |
| Trend/Break additions, 67 configs | Continuous ancestors | 670 / 0.7715 | 81 / 1.0270 | 0 / unavailable | 0 |
| Trend/Break additions, 67 configs | Independent processed sets | 1,093 / 0.6877 | 265 / 0.7105 | 7 / 5.8867 | 14 |

Actions count modeled entries, additions and closes. Native protection orders are excluded. The high baseline execution PF has only 11 closes. The independent path increases activity but fails the PF requirement; it is selectable for research and is not promoted automatically. Existing connection settings retain the default continuous-ancestor policy.

Core Base's final *validated own windows* have PF 2.0928 across 54 passing sets / 1,080 samples, while all subsequent Base closes have PF 0.7416. For Trend/Break the respective values are 1.8146 across 84 sets / 1,680 samples and 0.7842 across 3,629 closes. These are different denominators. Selected-window PF does not erase losses or establish high forward PF.

A separate predefined 28-profile training search for the independent path found **zero** profiles with at least 20 closes and PF ≥ 1.1 at all three subsequent stages. Its highest worst-stage training score was 0.7497 (8/3/3 windows, all coordinations). Its comparison holdout produced Main PF 0.9214 / 3,071 closes, Real 1.0357 / 2,233, and modeled execution 0.8137 / 670. It remains rejected; increased counts do not justify its promotion.

The repeat scripts preserve both losing and winning results, explicit no-loss/empty PF states, daily modeled executions, long/short counts, unfinished positions, source digests, process measurements and the declared paper-equity denominator. Actual complete closed owned exchange lots must be reported separately from these modeled executions.

## Reproduction

Use Node 24 and a frozen study JSON plus the exact candle files matching its declared SHA-256 digests:

```sh
node --import tsx scripts/stage-simulation.ts --selection /absolute/frozen-study.json --variant core --data /absolute/candles --output /absolute/comparison.json
node --import tsx scripts/stage-profile-study.mjs --processed --selection /absolute/trend-break-study.json --data /absolute/candles --output /absolute/profile-comparison.json
node --expose-gc --import tsx scripts/benchmark-engine.ts --candles /absolute/candles/BTC-USDT-10080.json --symbols 6 --bars 500 --output /absolute/benchmark.json
npm run check
```

Omit `--variant core` when using the additions-only study. The benchmark replicates one observed series under synthetic symbol IDs solely to measure load; it is not market performance evidence. The evidence package preserves the complete JSON studies and public candle inputs.
