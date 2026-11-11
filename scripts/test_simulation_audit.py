"""Accounting regressions: a matching return percentage must not hide different allocations."""
import copy
import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('simulation_audit', Path(__file__).with_name('audit-simulation.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SimulationAuditTest(unittest.TestCase):
    def fixture(self, root, scale_live=1, duplicate_fee=False):
        end = 1_800_000_000_000
        profile = {'name': 'fixture-real-mirror', 'liveEntryMode': 'real-mirror'}
        proof = {'qualified': True, 'count': 8, 'required': 8, 'profitFactor': 2, 'minPF': 1.1}
        trades = []
        for stage in ['real', 'live']:
            scale = scale_live if stage == 'live' else 1
            cost = 1.1 * scale * (2 if duplicate_fee else 1)
            trade = {'id': stage + '-close', 'laneId': json.dumps(['bingx-x02', 'ETH-USDT', 'config', 'long', 'block', stage]),
                     'configId': 'config', 'symbol': 'ETH-USDT', 'direction': 'long', 'stage': stage, 'coordination': 'block',
                     'openedAt': end - 3_000_000, 'closedAt': end - 2_000_000, 'entryPrice': 100, 'exitPrice': 101,
                     'quantity': 10 * scale, 'notional': 1000 * scale, 'grossPnl': 10 * scale, 'cost': cost,
                     'netPnl': 10 * scale - cost, 'netReturnPct': (10 * scale - cost) / (10 * scale),
                     'reason': 'take-profit', 'fills': [{'price': 100, 'quantity': 10 * scale}],
                     'admission': [proof] * (2 if stage == 'real' else 3)}
            if stage == 'live':
                trade['parentPositionId'] = 'real-close'
            trades.append(trade)
        folder = root / 'trades' / 'ETH-USDT' / 'Trend'
        folder.mkdir(parents=True)
        with gzip.open(folder / (profile['name'] + '.ndjson.gz'), 'wt') as stream:
            stream.write(json.dumps({'profile': profile, 'sourceHash': 'fixture', 'prehistorySelectedIds': ['config'], 'ordersSubmitted': 0}) + '\n')
            for trade in trades:
                stream.write(json.dumps(trade) + '\n')
        totals = {stage: module.empty() for stage in module.STAGES}
        for trade in trades:
            module.add(totals[trade['stage']], trade)
        names = [profile['name'], 'prehistory-selected-' + profile['name']]
        results = [{'profile': name, 'totals': totals} for name in names]
        job = {'id': 'fixture', 'symbol': 'ETH-USDT', 'type': 'Trend', 'sourceHash': 'fixture',
               'calculationProof': [{'processedCandles': 160, 'lastTimestamp': end}],
               'trainingSelections': [{'profile': profile['name'], 'selectedIds': ['config']}], 'results': results}
        (root / 'completed').mkdir()
        (root / 'completed' / 'fixture.json').write_text(json.dumps(job))
        coverage = {stage: {'sets': 1, 'enough': 1, 'admissionReady': 1} for stage in module.STAGES}
        summary = {'settings': {'sourceHash': 'fixture', 'hours': 1, 'warmup': 100,
                              'fees': {'takerFeePct': .05}, 'catalog': {'slippagePctOfFees': 10}},
                   'profiles': [profile], 'manifest': {'cutoff': end, 'symbols': ['ETH-USDT']}, 'types': ['Trend'], 'completedJobs': 1,
                   'summaries': [{'profile': {'name': name}, 'stages': copy.deepcopy(totals),
                                  'hourly': [{'hour': 0, 'stages': copy.deepcopy(totals), 'coverage': coverage}]} for name in names]}
        (root / 'summary.json').write_text(json.dumps(summary))

    def test_exact_real_live_allocation_and_once_only_cost_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(Path(directory))
            result = module.audit(directory)
            self.assertEqual(result['matchedRealLiveClosures'], 1)
            self.assertEqual(result['closedTradeRecords'], 2)

    def test_equal_return_pct_cannot_hide_doubled_live_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(Path(directory), scale_live=2)
            with self.assertRaisesRegex(ValueError, 'Real / Live path diverged: quantity'):
                module.audit(directory)

    def test_double_fee_is_rejected_even_when_report_totals_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(Path(directory), duplicate_fee=True)
            with self.assertRaisesRegex(ValueError, 'single-roundtrip-cost'):
                module.audit(directory)


if __name__ == '__main__':
    unittest.main()
