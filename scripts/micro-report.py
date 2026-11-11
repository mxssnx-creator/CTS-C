"""Reproducible standalone HTML evidence; no credentials, exchange calls or invented outcomes."""
import argparse
import collections
import html
import io
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

p = argparse.ArgumentParser()
p.add_argument('--study', required=True)
p.add_argument('--live')
p.add_argument('--executor-log', required=True)
p.add_argument('--output', required=True)
p.add_argument('--verification')
a = p.parse_args()
target=Path(a.output);target.parent.mkdir(parents=True,exist_ok=True)
study = json.loads(Path(a.study).read_text())
live = json.loads(Path(a.live).read_text()) if a.live and Path(a.live).exists() else None
raw = Path(a.executor_log).read_text()
diagnostic = json.loads(raw[raw.index('\n{\n') + 1:])
verification = json.loads(Path(a.verification).read_text()) if a.verification else {}
esc = lambda x: html.escape(str(x))
stages = ['base', 'main', 'real', 'live']
coords = ['normal', 'axis', 'block', 'dca']
colors = ['#468bff', '#a685ed', '#edb557', '#49cfa7']

def pf(v):
    if not v or not v.get('closes', v.get('closed', 0)):
        return '—'
    return '∞' if v.get('pfState') == 'no-losses' else f"{v.get('profitFactor', 1):.3f}"

def combine(values):
    out = {k: sum(v.get(k, 0) for v in values) for k in ['closes', 'profit', 'loss', 'pnl', 'fees', 'entries', 'adds']}
    out['profitFactor'] = out['profit'] / out['loss'] if out['loss'] else (999 if out['profit'] else 1)
    out['pfState'] = 'finite' if out['loss'] else ('no-losses' if out['profit'] else 'empty')
    return out

def table(headers, rows, search=False):
    return ('<div class="scroll"><table' + (' class="searchable"' if search else '') + '><thead><tr>' + ''.join(f'<th>{esc(h)}</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{esc(c)}</td>' for c in row) + '</tr>' for row in rows) + '</tbody></table></div>')

plt.rcParams.update({'font.family':'DejaVu Sans', 'font.size':10, 'figure.facecolor':'#142034', 'axes.facecolor':'#142034', 'axes.edgecolor':'#506079', 'axes.labelcolor':'#d9e6f7', 'text.color':'#d9e6f7', 'xtick.color':'#b8c9df', 'ytick.color':'#b8c9df', 'grid.color':'#35475e', 'svg.fonttype':'none'})
chart_index=0
def svg(fig):
    global chart_index
    chart_index+=1
    fig.savefig(target.with_name(target.stem+f'-chart-{chart_index}.png'),dpi=130,bbox_inches='tight')
    out = io.StringIO()
    fig.savefig(out, format='svg', bbox_inches='tight')
    plt.close(fig)
    return out.getvalue()[out.getvalue().index('<svg'):]

fig, ax = plt.subplots(figsize=(9, 3.6))
ax.bar([s.title() if s != 'live' else 'Live paper' for s in stages], [study['stages'][s]['profitFactor'] for s in stages], color=colors)
ax.axhline(1, color='#ffbf76', linestyle='--', label='PF 1.0')
ax.set_ylabel('Forward PF after costs');ax.set_ylim(0, max(1.15, max(study['stages'][s]['profitFactor'] for s in stages)*1.15));ax.legend()
stage_chart = svg(fig)

hours = sorted(set(k.split('/')[0] for k in study['hourly']))
fig, axes = plt.subplots(2, 1, figsize=(11, 6), sharex=True)
for s, color in zip(stages, colors):
    vals = [study['hourly'].get(f'{h}/{s}', {}) for h in hours]
    axes[0].plot(range(len(hours)), [min(v.get('profitFactor', 0), 3) if v.get('closes') else float('nan') for v in vals], label=s.title(), color=color)
    axes[1].plot(range(len(hours)), [v.get('closes', 0) for v in vals], label=s.title(), color=color)
axes[0].axhline(1, color='#ffbf76', linestyle='--');axes[0].set_ylabel('Hourly PF (display cap 3)');axes[0].legend(ncol=4)
axes[1].set_ylabel('Closes');axes[1].set_xticks(range(0, len(hours), max(1, len(hours)//10)), [hours[i][5:16] for i in range(0, len(hours), max(1, len(hours)//10))], rotation=35, ha='right')
axes[1].set_xlabel('UTC hour; exact PF and no-loss states in table')
hour_chart = svg(fig)

coord_rows=[]
for s in stages:
    for c in coords:
        vals=[v for k,v in study['groups'].items() if k.endswith(f'/{c}/{s}')]
        v=combine(vals)
        coord_rows.append([s, c, v['entries'], v['closes'], pf(v), f"{v['pnl']:.6f}", f"{v['fees']:.6f}", v['adds']])

grid=sum(r['selection']['configurations'] for r in study['rows'])
enough=sum(r['selection']['enoughSamples'] for r in study['rows'])
qualified=sum(r['selection']['eligible'] for r in study['rows'])
selected=sum(len(r['forward']) for r in study['rows'])
symbol_rows=[]
for r in study['rows']:
    agg={s:combine([v for f in r['forward'] for v in f['stages'] if v['stage']==s]) for s in stages}
    symbol_rows.append([r['symbol'],r['bars'],r['selection']['configurations'],r['selection']['enoughSamples'],f"{r['selection']['samplesPercent']:.2f}%",r['selection']['eligible'],len(r['forward'])]+[f"{agg[s]['closes']} / {pf(agg[s])}" for s in stages])

fig, ax=plt.subplots(figsize=(11, 3.8))
labels=[r['symbol'].replace('-USDT','') for r in study['rows']]
ax.bar(range(len(labels)),[r['selection']['samplesPercent'] for r in study['rows']],color='#468bff',label='Enough training samples')
ax.bar(range(len(labels)),[100*r['selection']['eligible']/r['selection']['configurations'] for r in study['rows']],color='#49cfa7',label='Training PF and samples pass')
ax.set_xticks(range(len(labels)),labels,rotation=90,fontsize=7);ax.set_ylim(0,105);ax.set_ylabel('% of configurations');ax.legend(ncol=2)
coverage_chart=svg(fig)

heatmaps=''
for range_name in ['Micro','Low-Range']:
    rows=[]
    for step in [2,3,4,5]:
        cells=[f'Step {step}']
        for ri in range(2,17):
            ratio=ri/10
            vals=[v for k,v in study['groups'].items() if k.startswith(f'{range_name}/') and f'/tp{step}/sl{ratio:g}/' in k and k.endswith('/live')]
            v=combine(vals);cells.append(f"{pf(v)} ({v['closes']})" if v['closes'] else '—')
        rows.append(cells)
    heatmaps+=f'<h3>{range_name}: frozen candidates, Live-paper PF (closes)</h3>'+table(['TP step']+[f'{i/10:.1f}' for i in range(2,17)],rows)

indication_rows=[]
for indication in study['settings']['strategyIndicationTypes']:
    for mode in study['settings']['strategyExitModes']:
        configs=sum(1 for r in study['rows'] for f in r['forward'] if f['config']['tactic']==indication and f['config']['exitMode']==mode)
        vals=[v for k,v in study['groups'].items() if k.split('/')[1]==indication and k.split('/')[4]==mode and k.endswith('/live')]
        v=combine(vals)
        indication_rows.append([indication,mode,grid//12,configs,v['closes'],pf(v),f"{v['pnl']:.6f}"])

hour_rows=[]
for h in hours:
    for s in stages:
        v=study['hourly'].get(f'{h}/{s}',{})
        hour_rows.append([h,s,v.get('closes',0),pf(v),f"{v.get('pnl',0):.6f}",f"{v.get('fees',0):.6f}"])

live_section='<p>The automatic 50-symbol run has no finalized result attached yet. Do not treat this report as confirmation of automatic live profitability.</p>'
if live:
    account=live['accounting']
    live_section=table(['Measure','Observed value'],[
        ['Environment',live['environment']],['Finished',live['generatedAt']],['Run error',live.get('runError') or 'None'],['Cleanup error',live.get('cleanupError') or 'None'],['Owned open lots after cleanup',live['ownedOpenLots']],['Owned reconciled closes',account['executionPF']['closed']],['Actual execution PF',pf(account['executionPF'])],['Validated execution PF',pf(account['validatedExecutionPF'])],['Actual signed fees',account['fees']],['Actual net PnL',account['realizedNetPnl']],['Whole-account snapshot unchanged',live['foreignInventoryPreserved']],['Final total account positions / orders',f"{live['finalPositionCount']} / {live['finalOrderCount']}"]])
    live_section+='<p>Whole-account snapshots can change through other users of the shared account. Owned order attribution and cleanup are separate checks. Diagnostic orders below do not count as strategy qualification.</p>'
    live_section+=table(['Symbol','Recorded bars','Complete','First timestamp ms','Last timestamp ms'],[[r['symbol'],r['bars'],r['complete'],r.get('first','—'),r.get('last','—')] for r in live['tradeBarCoverage']])

diagnostic_table=table(['Side','Entry qty','Added qty','Actual add ratio','Closed qty','Gross PnL','Signed fees','Net PnL','Protection'],[[r['direction'],r['entryQuantity'],r['addedQuantity'],r['actualAddRatio'],r['closedQuantity'],f"{r['realizedGrossPnl']:.6f}",f"{r['fees']:.6f}",f"{r['realizedNetPnl']:.6f}",r['protection']] for r in diagnostic['results']])
stage_table=table(['Stage','Entries','Closes','Forward PF','Net PnL (model units)','Costs (model units)'],[[s,study['stages'][s]['entries'],study['stages'][s]['closes'],pf(study['stages'][s]),f"{study['stages'][s]['pnl']:.6f}",f"{study['stages'][s]['fees']:.6f}"] for s in stages])
detail_rows=[[k,v['closes'],pf(v),f"{v['pnl']:.6f}",v['entries'],v['adds']] for k,v in sorted(study['groups'].items())]
source_links='<ul><li><a href="https://bingxservice.zendesk.com/hc/en-001/articles/11263240298255-Perpetual-Futures-Fee-Schedule">BingX perpetual fee schedule</a></li><li><a href="https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-ws-market/api-reference.md">BingX official trade WebSocket reference</a></li><li><a href="https://github.com/ccxt/ccxt/blob/master/python/ccxt/pro/bingx.py">CCXT BingX WebSocket implementation and VST host</a></li></ul>'
document=f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CTS-C · Micro / Low-Range · 50-symbol verification</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#0b1424;color:#d9e6f7;font:15px/1.6 system-ui,sans-serif}}main{{max-width:1320px;margin:auto;padding:34px}}h1{{font-size:clamp(26px,4vw,46px);line-height:1.15;margin:10px 0}}h2{{font-size:23px;margin-top:38px}}h3{{font-size:17px}}a{{color:#83b1ff}}.eyebrow{{color:#6ca7ff;letter-spacing:.15em;text-transform:uppercase;font-size:12px}}.muted,small{{color:#a7b9cf}}.warning{{background:#352327;border-left:4px solid #ef936e;padding:18px;margin:22px 0}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}}.card{{background:#142034;padding:18px;border:1px solid #273a54;border-radius:10px}}.card b{{font-size:30px;display:block}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}.chart{{background:#142034;padding:12px;border-radius:10px}}svg{{max-width:100%;height:auto}}.scroll{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;font-size:12px;margin:12px 0 24px}}th,td{{border-bottom:1px solid #2c4059;padding:9px 11px;text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}th{{background:#182a42;color:#c2d9f7;position:sticky;top:0}}tbody tr:hover{{background:#18283e}}details{{border:1px solid #2b3d55;border-radius:8px;padding:12px;margin-top:16px}}summary{{cursor:pointer;font-weight:600}}input{{background:#142034;color:white;border:1px solid #425773;padding:10px;border-radius:6px;width:min(100%,400px)}}pre{{white-space:pre-wrap;word-break:break-word;background:#142034;padding:16px}}@media(max-width:800px){{main{{padding:18px}}.grid{{grid-template-columns:1fr}}}}@media print{{body{{background:white;color:#172333}}.card,.chart{{break-inside:avoid}}details{{display:block}}}}
</style><main><div class="eyebrow">CTS-C · Evidence / 11 November 2026</div><h1>Micro and Low-Range<br>50-symbol verification</h1><p class="muted">Observed market data • chronological training and holdout • own stage evidence • actual x02 diagnostics</p>
<div class="warning"><b>Broad profitability target not met.</b> Selected candidates retained losses after Base. Functional correctness, current validated windows and future profitability are different measures. The results below preserve unsuccessful runs and do not promote parameters using the holdout.</div>
<div class="cards"><div class="card">Symbols<b>{study['completedSymbols']}</b></div><div class="card">Configurations<b>{grid:,}</b></div><div class="card">Enough samples<b>{100*enough/grid:.2f}%</b><small>{enough:,} configurations</small></div><div class="card">Training qualified<b>{100*qualified/grid:.3f}%</b><small>{qualified:,}; {selected} frozen selections</small></div></div>
<h2>Economics and independent sets</h2><p>Micro steps 2–5 and Low-Range steps 2–5 were tested with SL/TP 0.2–1.6 in 0.1 increments, three exit modes, and MA Cross / RSI Band / Trend / Break. Every combination has its own identity; directions, coordinations, stage proofs and 10-second versus one-minute evidence remain separate.</p>
{table(['Cost component','Percentage points'],[['Maker, per side','0.02%'],['Taker, per side','0.05%'],['Two market sides','0.10%'],['Modeled slippage, 10% of fees','0.01%'],['Modeled market round trip','0.11%']])}
<p>Step 2 therefore targets 0.22%; step 5 targets 0.55%. SL is TP × selected ratio. The thin trail factor is 0.5 × SL; a dynamic peak stop ratchets without loosening. Auto PF raises the per-configuration minimum from its TP distance while preserving each stage floor. Actual exchange accounting uses fills and signed commissions exactly once; the additional modeled cost is not deducted again.</p>
<h2>Forward stage outcomes</h2><div class="grid"><div class="chart">{stage_chart}</div><div>{stage_table}</div></div>
<p>The first 65% of 4,320 observed minute bars per symbol ranked candidates. Up to three training-qualified candidates per range were frozen; the remaining 35% supplied new forward positions. Base/Main/Real use 20/8/8 closes and PF 1.1, plus the configuration Auto PF floor. Axis uses five previous and two recent Normal Base closes; Block uses rounds of three, a 0.2 base-budget increment and a 1.6 cap. Base and derived stages learn from their own trades. Live paper mirrors accepted Real allocations. Minute-close replay cannot establish sub-minute stop ordering.</p>
<h2>Sampling and symbol coverage</h2><div class="chart">{coverage_chart}</div>
{table(['Symbol','Bars','Grid','Enough N','Enough %','Training qualified','Frozen','Base closes/PF','Main closes/PF','Real closes/PF','Live paper closes/PF'],symbol_rows,True)}
<h2>Coordinations versus Normal</h2><p>PF uses net percentage returns; increasing budget alone cannot improve it. Money PnL also reflects exposure. Zero closes means insufficient realized evidence, not a winning configuration. In this study Axis produced no held-out Main/Real/Live closes.</p>{table(['Stage','Coordination','Entries','Closes','PF','Net PnL','Costs','Adds'],coord_rows)}
<h2>Indications and exit types</h2>{table(['Indication','Exit','Training grid','Frozen','Live paper closes','PF','Net PnL'],indication_rows)}
<h2>Steps and SL ratios</h2><p>These cells describe only training-frozen candidates. A dash means no selected forward observations. It is not a zero loss or a failed execution.</p>{heatmaps}
<h2>Hourly details</h2><div class="chart">{hour_chart}</div><details><summary>Exact hourly PF, counts, PnL and modeled costs</summary>{table(['UTC hour','Stage','Closes','PF','Net PnL','Costs'],hour_rows)}</details>
<h2>x02 automatic observation</h2>{live_section}
<h2>Actual executor round trip</h2><p>The separate VST diagnostic confirmed long and short entry, a 20% quantity addition, native protection, owned closure and fee reconciliation. It was an execution diagnostic, not a qualified strategy trade. Both closes were negative. Residual diagnostic positions and orders: 0; its whole-account inventory comparison passed.</p>{diagnostic_table}
<h2>Data integrity and restart</h2><p>Observed trade events form 10-second OHLCV. Partial connection buckets, stale data and discontinuities do not create synthetic history. VST events in the probe omitted trade IDs; the parser preserves this as unavailable. Real IDs are deduplicated where present. Minute warmup and present-time tick/bar processing are separated. Two preliminary automatic attempts exposed a candle-path leak, submitted no owned strategy orders and are excluded from economic evidence. Restart, ownership, partial-fill and unknown-outcome behavior are covered by executable regressions; the final live record states the observed limits.</p>
<details><summary>Every selected configuration / coordination / stage</summary><p><input id="filter" placeholder="Filter symbol-independent configuration groups"></p>{table(['Range / indication / TP / SL / exit / coordination / stage','Closes','PF','Net PnL','Entries','Adds'],detail_rows,True)}</details>
<h2>Verification and provenance</h2><pre>{esc(json.dumps(verification,indent=2))}</pre><p>Study cutoff (milliseconds): {study['manifest']['cutoff']}; generated: {esc(study['generatedAt'])}. Raw candles, SHA-256 hashes, frozen choices and negative outcomes accompany the evidence archive. Model money totals are correlated hypothetical lanes, not account equity. Funding, liquidation, queue position and depth are outside the replay model.</p>
<h3>Primary references checked during implementation</h3>{source_links}<p class="muted">Sources support feed format and fees. They do not support profitability claims.</p></main><script>document.getElementById('filter').addEventListener('input',e=>{{const q=e.target.value.toLowerCase();document.querySelectorAll('table.searchable tbody tr').forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(q))}})</script></html>'''
target.write_text(document)
print(json.dumps({'report':str(target),'bytes':target.stat().st_size,'symbols':study['completedSymbols'],'configurations':grid,'sampleCoveragePercent':100*enough/grid,'trainingQualifiedPercent':100*qualified/grid,'liveRecordIncluded':live is not None}))
