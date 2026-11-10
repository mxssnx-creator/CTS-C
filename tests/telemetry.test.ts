import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TradingEngine} from '../core/engine'
import {TerminalRuntime} from '../core/runtime'
import {getStore} from '../core/store'

test('paper totals survive the recent-trade display limit and legacy missing fees stay unavailable',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ctsc-telemetry-')),previous=process.env.CTS_DATA_DIR
 process.env.CTS_DATA_DIR=directory
 const runtime=new TerminalRuntime()
 try{
  const engine=new TradingEngine({symbols:['BTC-USDT'],stageLastN:{base:1,main:1,real:1},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[.2],strategyExitModes:['fixed'],strategyIndicationTypes:['MA_Cross']}})
  engine.processCandles('BTC-USDT',Array.from({length:2500},(_,i)=>{const close=100+8*Math.sin(i/3);return {timestamp:1700000040000+i*60000,open:close,high:close,low:close,close,volume:1}}))
  const snap=engine.snapshot({laneLimit:0,positionLimit:0}),live=snap.stages.find(s=>s.stage==='live')!
  assert.ok(snap.liveTrades.length>snap.trades.filter(t=>t.stage==='live').length)
  runtime.engine=engine
  const view=runtime.snapshot()
  assert.equal(view.realizedPnl,live.netPnl);assert.equal(view.fees,live.fees);assert.equal(view.paperTotals.closed,live.closed)
  assert.equal(view.closedPositions.length,snap.liveTrades.length)
  const state=engine.exportState();for(const lane of Object.values(state.lanes))delete lane.costTotal
  delete state.recentLiveTrades
  runtime.engine=new TradingEngine(state.settings,state)
  assert.equal(runtime.snapshot().fees,null)
  assert.equal(runtime.snapshot().realizedPnl,live.netPnl)
 }finally{runtime.shutdown();getStore().close();if(previous===undefined)delete process.env.CTS_DATA_DIR;else process.env.CTS_DATA_DIR=previous;rmSync(directory,{recursive:true,force:true})}
})
