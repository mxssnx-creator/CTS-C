import test from "node:test";
import assert from "node:assert/strict";
import {windowMetrics,validateEngineSettings,TradingEngine} from "../core/engine";
import {hydrate,validateConfiguration} from "../core/settings-schema";
import type {LaneState} from "../core/types";
const blocks={long:20,short:10,minimal:3,shortPolarity:"negative" as const,minimalPolarity:"negative" as const};
test("native gates and saved settings use separate signed blocks, full coverage, and long-only PF",()=>{
 const lane={samples:[...Array(13).fill(-1),...Array(20).fill(2)],config:{},closedCount:33} as LaneState;
 const result=windowMetrics(lane,20,1.1,blocks);assert.equal(result.qualified,true);assert.equal(result.required,33);assert.equal(result.count,33);assert.ok(result.profitFactor>1);
 assert.equal(windowMetrics({...lane,samples:lane.samples.slice(1)},20,1.1,blocks).qualified,false);
 assert.equal(windowMetrics({...lane,samples:[NaN,...lane.samples.slice(1)]},20,1.1,blocks).qualified,false);
 const saved=validateConfiguration({stageBlocks:{base:blocks,main:blocks}},{partial:true});
 assert.deepEqual(hydrate({stageBlocks:JSON.stringify(saved.stageBlocks)}).stageBlocks,saved.stageBlocks);
 assert.throws(()=>validateEngineSettings({maxSamples:32,stageBlocks:{base:blocks}}));
 const e=new TradingEngine(validateEngineSettings({stageBlocks:{base:blocks},stageGateMode:"processed-sets"}));
 const restored=new TradingEngine(e.exportState().settings,JSON.parse(JSON.stringify(e.exportState())));
 assert.deepEqual(restored.exportState().settings.stageBlocks,{base:blocks});
});
