import test from "node:test";
import assert from "node:assert/strict";
import {windowMetrics,validateEngineSettings,TradingEngine} from "../core/engine";
import {hydrate,validateConfiguration} from "../core/settings-schema";
import {formatProfitFactor} from "../components/terminal/profit-factor";
import type {LaneState} from "../core/types";
const blocks={long:20,short:10,minimal:3,shortPolarity:"negative" as const,minimalPolarity:"negative" as const};
test("native gates and saved settings use separate signed blocks, full coverage, and long-only PF",()=>{
 const lane={samples:[...Array(13).fill(-1),...Array(20).fill(2)],config:{},closedCount:33} as LaneState;
 const result=windowMetrics(lane,20,1.1,blocks);assert.equal(result.qualified,true);assert.equal(result.required,33);assert.equal(result.count,33);assert.ok(result.profitFactor!==null&&result.profitFactor>1);
 assert.equal(windowMetrics({...lane,samples:lane.samples.slice(1)},20,1.1,blocks).qualified,false);
 assert.equal(windowMetrics({...lane,samples:[NaN,...lane.samples.slice(1)]},20,1.1,blocks).qualified,false);
 const saved=validateConfiguration({stageBlocks:{base:blocks,main:blocks}},{partial:true});
 assert.deepEqual(hydrate({stageBlocks:JSON.stringify(saved.stageBlocks)}).stageBlocks,saved.stageBlocks);
 assert.throws(()=>validateEngineSettings({maxSamples:32,stageBlocks:{base:blocks}}));
 const e=new TradingEngine(validateEngineSettings({stageBlocks:{base:blocks},stageGateMode:"processed-sets"}));
 const restored=new TradingEngine(e.exportState().settings,JSON.parse(JSON.stringify(e.exportState())));
 assert.deepEqual(restored.exportState().settings.stageBlocks,{base:blocks});
});
test("unknown retained outcomes cannot qualify ordinary, disjoint or Axis windows",()=>{
 const samples=[2,null,2,-1] as unknown as number[];
 const lane={samples,config:{},closedCount:4} as LaneState;
 const ordinary=windowMetrics(lane,4,1.1);
 assert.equal(ordinary.qualified,false);assert.equal(ordinary.enoughSamples,false);
 assert.equal(ordinary.pfState,'unknown');assert.equal(ordinary.profitFactor,null);
 for(const missing of [NaN,Infinity,undefined]){
  const value=windowMetrics({...lane,samples:[2,missing,2,-1] as number[]},4,1.1);
  assert.equal(value.qualified,false);assert.equal(value.pfState,'unknown');assert.equal(value.profitFactor,null);
 }
 const overflow=windowMetrics({...lane,samples:[Number.MAX_VALUE,Number.MAX_VALUE]},2,1.1);
 assert.equal(overflow.qualified,false);assert.equal(overflow.pfState,'unknown');assert.equal(overflow.profitFactor,null);
 const olderUnknown=windowMetrics({...lane,samples:[2,2,-1,1,null] as unknown as number[]},4,1.1);
 assert.equal(olderUnknown.qualified,true,'outcomes outside this window must not veto it');
 const corrupt=[null,...Array(12).fill(-1),...Array(20).fill(2)] as unknown as number[];
 const disjoint=windowMetrics({...lane,samples:corrupt,closedCount:33},20,1.1,blocks);
 assert.equal(disjoint.qualified,false);assert.equal(disjoint.pfState,'unknown');assert.equal(disjoint.profitFactor,null);
 assert.equal(formatProfitFactor(null,'unknown'),'— · unknown');

 const engine=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']},coordinations:{axis:{enabled:true,previous:2,last:1,outcome:'any'},block:{enabled:false,steps:2,ratio:.2,mode:'shared'},dca:{enabled:false,steps:1,distancePct:1,multiplier:1}}});
 const internal=engine as any,config=internal.configs[0],normal=internal.lane('BTC-USDT',config,'long','normal','base');
 normal.samples=[1,null,2];normal.closedCount=3;
 assert.equal(internal.axisAllows('BTC-USDT',config,'long','base'),false);
 const snapshot=engine.snapshot(),current=snapshot.lanes.find(x=>x.id===normal.id)!;
 assert.equal(current.pfState,'unknown');assert.equal(current.profitFactor,null);
 assert.equal(snapshot.stages.find(x=>x.stage==='base')!.currentPfState,'unknown');
 const restored=TradingEngine.fromSerialized(engine.serializeState()).snapshot();
 assert.equal(restored.lanes.find(x=>x.id===normal.id)!.pfState,'unknown');
 assert.equal(restored.stages.find(x=>x.stage==='base')!.currentProfitFactor,null);
});
