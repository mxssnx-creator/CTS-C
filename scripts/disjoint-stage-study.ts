/** Bounded, observed-market regression. No exchange adapter or private credential is imported. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {TradingEngine,STAGES,validateObservedCandles} from '../core/engine';
import {describeProfitFactor} from '../core/metrics';
import type {Candle,Stage} from '../core/types';
import type {BlockPolicy} from '../shared/cts-lastn/blocks';
const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]};
async function main(){
const root=resolve(arg('--data','../disjoint-market')),output=resolve(arg('--output','../disjoint-study'));
const manifestRaw=await readFile(join(root,'manifest.json'),'utf8'),manifest=JSON.parse(manifestRaw);
const empty=()=>({entries:0,closes:0,profit:0,loss:0,cash:0,cost:0});
const stageTotals=()=>Object.fromEntries(STAGES.map(s=>[s,empty()])) as Record<Stage,ReturnType<typeof empty>>;
const profiles:Array<{name:string;blocks?:BlockPolicy}>= [{name:'legacy-overlapping'},...(['positive','negative'] as const).flatMap(shortPolarity=>(['positive','negative'] as const).map(minimalPolarity=>({name:`disjoint-20-10-3-${shortPolarity}-${minimalPolarity}`,blocks:{long:20,short:10,minimal:3,shortPolarity,minimalPolarity}})))];
const results=[],start=performance.now();let maxRssKiB=0;
for(const profile of profiles){
 let qualifiedRealEntries=0,mirroredQualifiedReal=0;const totals=stageTotals(),rows=[],hourly=new Map<number,ReturnType<typeof stageTotals>>();const began=performance.now();
 for(const data of manifest.datasets){
  const raw=await readFile(join(root,data.file),'utf8');if(createHash('sha256').update(raw).digest('hex')!==data.sha256)throw Error('Dataset digest mismatch');
  const bars=JSON.parse(raw) as Candle[];validateObservedCandles(bars);const warmup=4320;if(bars.length<warmup+1440)throw Error('Incomplete 72h/24h dataset');
  let engine=new TradingEngine({symbols:[data.symbol],stageGateMode:'processed-sets',liveEntryMode:'real-mirror',stageBlocks:profile.blocks?{base:profile.blocks,main:profile.blocks}:{},stageLastN:{base:20,main:10,real:8},stageMinPF:{base:1.1,main:1.1,real:1.1},catalog:{strategyTpSteps:[3],strategySlRatios:[.6],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend'],strategySignalPeriods:[20],strategySignalTimeframes:[1],makerFeePct:.02,takerFeePct:.05,slippagePctOfFees:10}});
  engine.processCandles(data.symbol,bars.slice(0,warmup),{eventLimit:0});const trained=engine.exportState();for(const lane of Object.values(trained.lanes))delete lane.open;engine=TradingEngine.fromOwnedCheckpoint(trained);
  const own=stageTotals();let costErrors=0,missingParents=0;
  for(let h=0;h<24;h++){
   const at=warmup+h*60,hour=hourly.get(h)??stageTotals();hourly.set(h,hour);
   const events=[];
   for(const candle of bars.slice(at,at+60)){
    const batch=engine.processCandles(data.symbol,[candle]);events.push(...batch);
    const openings=batch.filter(e=>e.type==='opened'&&(e.stage==='real'||e.stage==='live'));
    if(openings.length){
     const snapshot=engine.snapshot({laneLimit:1000,positionLimit:1000});
     const qualified=new Set(snapshot.lanes.filter(l=>l.stage==='real'&&l.validated).map(l=>l.id));
     const parents=new Set(snapshot.positions.filter(p=>p.stage==='live'&&p.openedAt===candle.timestamp).map(p=>p.parentPositionId));
     for(const e of openings.filter(e=>e.stage==='real'&&qualified.has(e.laneId))){
      qualifiedRealEntries++;const real=snapshot.positions.find(p=>p.laneId===e.laneId);
      if(real&&parents.has(real.id))mirroredQualifiedReal++;
     }
    }
   }
   for(const e of events){const targets=[totals[e.stage],own[e.stage],hour[e.stage]];
    if(e.type==='opened')for(const row of targets)row.entries++;
    if(e.trade){const t=e.trade;if(Math.abs(t.grossPnl-t.cost-t.netPnl)>1e-8)costErrors++;
     if(t.stage==='live'&&!t.parentPositionId)missingParents++;
     for(const row of targets){row.closes++;row.profit+=Math.max(t.netReturnPct,0);row.loss+=Math.max(-t.netReturnPct,0);row.cash+=t.netPnl;row.cost+=t.cost;}
    }
   }
  }
  if(costErrors||missingParents)throw Error('Cost or Real-parent reconciliation failure');
  const stats=engine.snapshot({laneLimit:0,positionLimit:0});maxRssKiB=Math.max(maxRssKiB,process.resourceUsage().maxRSS);
  rows.push({symbol:data.symbol,stages:own,coverage:stats.stages.map(s=>({stage:s.stage,sets:s.currentLanes,enough:s.currentEnoughSamples,qualified:s.currentQualified,validatedWindow:s.validatedWindow})),costErrors,missingParents});
 }
 const result={...profile,qualifiedRealEntries,mirroredQualifiedReal,qualifiedRealMirrorPct:qualifiedRealEntries?100*mirroredQualifiedReal/qualifiedRealEntries:null,symbols:rows.length,stages:Object.fromEntries(STAGES.map(s=>[s,{...totals[s],...describeProfitFactor(totals[s].profit,totals[s].loss,totals[s].closes)}])),liveRealEntryPct:totals.real.entries?100*totals.live.entries/totals.real.entries:null,hourly:[...hourly].map(([hour,stages])=>({hour,stages})),rows,elapsedMs:performance.now()-began};
 results.push(result);console.log(JSON.stringify({profile:profile.name,symbols:rows.length,stages:result.stages,liveRealEntryPct:result.liveRealEntryPct,qualifiedRealEntries,mirroredQualifiedReal,qualifiedRealMirrorPct:result.qualifiedRealMirrorPct,elapsedMs:result.elapsedMs}));
}
await mkdir(output,{recursive:true});await writeFile(join(output,'summary.json'),JSON.stringify({kind:'bounded-disjoint-block-regression',generatedAt:new Date().toISOString(),ordersSubmitted:0,exchangeExecutionPF:null,datasetManifestSha256:createHash('sha256').update(manifestRaw).digest('hex'),methodology:'Frozen previously inspected BingX VST minute candles: 72h prehistory and 24h subsequent observed prices, 50 symbols, one Trend/Micro TP3 SL0.6 fixed-exit configuration per symbol, both directions and independent Normal/Axis/Block/DCA. All four signed 20+10+3 policies are reported alongside overlapping baseline without selecting a forward winner. Each stage uses own closes, Real N8 and modeled Live mirrors accepted Real positions. Net returns deduct 0.05% taker per execution leg and slippage at 10% of fees. Unfinished training positions are discarded. Results are retrospective modeled evidence, not untouched validation or native venue fills; minimum lot sizes, latency and funding are not simulated. This bounded coverage does not represent every indication or the full 1,560 simultaneous-policy matrix.',elapsedMs:performance.now()-start,maxRssKiB,results},null,2)+'\n');

}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1});
