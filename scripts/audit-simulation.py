#!/usr/bin/env python3
"""Independently recompute cash, return PF and hourly closes from every gzip ledger."""
import argparse, gzip, hashlib, json, math
from pathlib import Path

STAGES=['base','main','real','live']
KEYS=['closes','wins','profit','loss','netPnl','cost','notional']
def empty(): return {k:0 for k in KEYS}
def add(row,t):
    row['closes']+=1; row['wins']+=int(t['netReturnPct']>0)
    row['profit']+=max(0,t['netReturnPct']); row['loss']+=max(0,-t['netReturnPct'])
    for k in ['netPnl','cost','notional']:row[k]+=t[k]
def close(a,b,context):
    if not math.isfinite(a) or not math.isfinite(b) or not math.isclose(a,b,rel_tol=1e-8,abs_tol=1e-8):raise ValueError(f'{context}: {a} != {b}')
def check_totals(actual,expected,context):
    for k in KEYS:close(actual[k],expected[k],context+'/'+k)

def audit(root):
    root=Path(root); data=json.loads((root/'summary.json').read_text()); sums={s['profile']['name']:{k:empty() for k in STAGES} for s in data['summaries']}
    hours={p:[{s:empty() for s in STAGES} for _ in range(data['settings']['hours'])] for p in sums}
    start=data['manifest']['cutoff']-data['settings']['hours']*3600000; end=data['manifest']['cutoff']; files=[]; total=0; parent_checks=0
    fee_pct=2*data['settings']['fees']['takerFeePct']*(1+data['settings']['catalog']['slippagePctOfFees']/100)
    jobs=0
    for path in sorted((root/'completed').glob('*.json')):
        job=json.loads(path.read_text());jobs+=1
        if job['sourceHash']!=data['settings']['sourceHash']:raise ValueError('Mixed source checkpoint')
        for proof in job['calculationProof']:
            if proof['processedCandles']!=data['settings']['warmup']+data['settings']['hours']*60 or proof['lastTimestamp']!=end:raise ValueError('Incomplete calculation')
        for base in [p['name'] for p in data['profiles'] if not p.get('frozenPrehistory')]:
            path=root/'trades'/job['symbol']/job['type']/(base+'.ndjson.gz'); digest=hashlib.sha256(); local={p:{s:empty() for s in STAGES} for p in [base,'prehistory-selected-'+base]}; parents={}; last_at=None
            with gzip.open(path,'rb') as f:
                header=json.loads(next(f)); selected=set(header['prehistorySelectedIds'])
                if header['sourceHash']!=data['settings']['sourceHash'] or header['ordersSubmitted']!=0:raise ValueError('Invalid ledger provenance')
                frozen=next(s for s in job['trainingSelections'] if s['profile']==base)
                if selected!=set(frozen['selectedIds']):raise ValueError('Changed frozen cohort')
                for line in f:
                    digest.update(line);t=json.loads(line);total+=1
                    if not(start<t['openedAt']<=t['closedAt']<=end):raise ValueError('Trade crosses train/forward boundary')
                    lane=json.loads(t['laneId'])
                    if lane[:6]!=['bingx-x02',job['symbol'],t['configId'],t['direction'],t['coordination'],t['stage']]:raise ValueError('Cross-lane trade')
                    q=sum(v['quantity'] for v in t['fills']); cost_basis=sum(v['price']*v['quantity'] for v in t['fills']); entry=cost_basis/q
                    close(q,t['quantity'],'quantity');close(cost_basis,t['notional'],'notional');close(entry,t['entryPrice'],'weighted-entry')
                    gross=(1 if t['direction']=='long' else -1)*(t['exitPrice']-entry)*q
                    close(gross,t['grossPnl'],'gross');close(t['notional']*fee_pct/100,t['cost'],'single-roundtrip-cost')
                    close(gross-t['cost'],t['netPnl'],'net');close(100*t['netPnl']/t['notional'],t['netReturnPct'],'net-return')
                    if t['stage']!='base':
                        proofs=t.get('admission',[])
                        if len(proofs)!=STAGES.index(t['stage']) or any(not p['qualified'] or p['count']!=p['required'] or p['profitFactor']<p['minPF'] for p in proofs):raise ValueError('Unqualified stage admission')
                    # Events are ordered by bar then stage: retain only this close timestamp's Real parents.
                    if last_at!=t['closedAt']:parents={};last_at=t['closedAt']
                    if t['stage']=='real':parents[t['id']]=t
                    if header['profile']['liveEntryMode']=='real-mirror' and t['stage']=='live':
                        parent=parents.get(t.get('parentPositionId'))
                        if not parent:raise ValueError('Unmatched Real / Live close')
                        for k in ['configId','symbol','direction','coordination','openedAt','closedAt','entryPrice','exitPrice','quantity','notional','fills','grossPnl','cost','netPnl','netReturnPct','reason']:
                            if t[k]!=parent[k]:raise ValueError('Real / Live path diverged: '+k)
                        parent_checks+=1
                    hour=int((t['closedAt']-start-1)//3600000)
                    for name in local:
                        if name!=base and t['configId'] not in selected:continue
                        add(local[name][t['stage']],t);add(sums[name][t['stage']],t);add(hours[name][hour][t['stage']],t)
            for name,stages in local.items():
                expected=next(x for x in job['results'] if x['profile']==name)
                for stage in STAGES:check_totals(stages[stage],expected['totals'][stage],job['id']+'/'+name+'/'+stage)
            files.append({'path':str(path.relative_to(root)),'tradeLinesSha256':digest.hexdigest()})
    if jobs!=data['completedJobs'] or jobs!=len(data['manifest']['symbols'])*len(data['types']):raise ValueError('Incomplete job matrix')
    for summary in data['summaries']:
        name=summary['profile']['name']
        for stage in STAGES:check_totals(sums[name][stage],summary['stages'][stage],name+'/'+stage)
        for h in summary['hourly']:
            for stage in STAGES:
                check_totals(hours[name][h['hour']][stage],h['stages'][stage],name+'/'+str(h['hour'])+'/'+stage)
                c=h['coverage'][stage]
                if not 0<=c['enough']<=c['sets'] or not 0<=c['admissionReady']<=c['sets']:raise ValueError('Invalid evidence denominator')
    return {'passed':True,'jobs':jobs,'ledgerFiles':len(files),'closedTradeRecords':total,'matchedRealLiveClosures':parent_checks,'ordersSubmitted':0,'checks':['all jobs consumed all bars','frozen prehistory membership','exact symbol/configuration/direction/stage/coordination identity','weighted fills and quantities','single roundtrip fee and slippage deduction','gross/net/cost and normalized return','every post-Base admission proof','exact Real / Live fills, quantity, notional, costs, PnL and close path','all profile totals and hourly closes','sample coverage denominators'],'profiles':sums,'ledgerDigests':files}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--output',required=True);a=p.parse_args();result=audit(a.root);Path(a.output).write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ['profiles','ledgerDigests']}))
