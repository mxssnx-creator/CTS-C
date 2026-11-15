import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {StateStore} from '../core/store'
import {TradingEngine} from '../core/engine'
import {TerminalRuntime} from '../core/runtime'
import {DemoExecutor,type OwnedLot} from '../core/executor'
import type {ClosedTrade,ExecutionIntent} from '../core/types'

const connection='bingx-x02',position='retained-own-episode',key=JSON.stringify([connection,position])
const trade:ClosedTrade={id:position,laneId:'retained-lane',configId:'retired-own-config',symbol:'BTC-USDT',direction:'long',stage:'live',coordination:'dca',openedAt:1790000040000,closedAt:1790000100000,entryPrice:100,exitPrice:100,quantity:2,notional:200,grossPnl:0,cost:.2,netPnl:-.2,netReturnPct:-.1,reason:'stop_loss',fills:[],source:'paper'}
const intent:ExecutionIntent={id:'retained-entry',connectionId:connection,laneId:trade.laneId,configId:trade.configId,symbol:trade.symbol,direction:trade.direction,positionId:position,kind:'entry',requestedQuantity:2,notional:200,price:100,timestamp:trade.openedAt,takeProfitPct:1,stopLossPct:1,exitMode:'fixed',source:'real-qualified',status:'acknowledged',qualificationId:'own-fixture-proof'}
const lot:OwnedLot={id:key,connectionId:connection,laneId:trade.laneId,symbol:trade.symbol,direction:trade.direction,quantity:0,averageEntry:100,openedQuantity:2,closedQuantity:2,openedNotional:200,realizedGrossPnl:-.2,fees:.1,realizedNetPnl:-.3,exchangeRealizedPnl:-.2,updatedAt:trade.closedAt,protection:'closed',executionIntent:intent}
const noVenue=()=>({configured:false}) as any
function seed(store:StateStore,closes:ClosedTrade[]){
 const engine=new TradingEngine({symbols:['BTC-USDT'],catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['Trend']}})
 const state=engine.exportState();state.recentLiveTrades=structuredClone(closes)
 store.saveEngine(state);store.set('executor:owned-lots',{[key]:structuredClone(lot)})
}
function executor(store:StateStore){return new DemoExecutor(store,{configured:false} as any,{connectionId:connection})}

test('restart recovers only exact retained own model exits after ownership and preserves a losing pair',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ctsc-model-recovery-')),file=join(dir,'runtime.sqlite')
 let store=new StateStore(file),runtime:TerminalRuntime|undefined
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No network allowed in recovery fixture')}
 try{
  seed(store,[trade,{...trade,id:'unowned-episode'}]);runtime=new TerminalRuntime(connection,store,noVenue)
  assert.equal(executor(store).comparison().awaitingSimulation,1)
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM execution_simulation').get()!.n,0,'unowned hydration must not write comparisons')
  runtime.pause()
  const paired=executor(store).comparison();assert.equal(paired.matched,1);assert.equal(paired.awaitingSimulation,0)
  assert.equal(paired.exchangePF.profitFactor,0);assert.equal(paired.simulatedPF.profitFactor,0)
  assert.equal(paired.rows[0].exchangeNetPnl,-.3);assert.equal(paired.rows[0].simulatedReturnPct,-.1)
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM execution_simulation').get()!.n,1,'unowned model episodes are never imported')
  runtime.shutdown();store.close();runtime=undefined
  store=new StateStore(file);runtime=new TerminalRuntime(connection,store,noVenue);runtime.pause()
  assert.equal(executor(store).comparison().matched,1)
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM execution_simulation').get()!.n,1)
  assert.equal(store.intents().length,0,'comparison repair submits no execution intent')
 }finally{runtime?.shutdown();store.close();globalThis.fetch=fetch;rmSync(dir,{recursive:true,force:true})}
})

test('another writer blocks repair, and missing retained model evidence stays unavailable',()=>{
 const store=new StateStore(':memory:');let runtime:TerminalRuntime|undefined
 try{
  seed(store,[trade]);store.acquireLease('other-owner');runtime=new TerminalRuntime(connection,store,noVenue)
  assert.throws(()=>runtime!.pause(),/Another CTS-C process/)
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM execution_simulation').get()!.n,0)
  store.releaseLease('other-owner');runtime.pause();assert.equal(executor(store).comparison().matched,1)
  runtime.shutdown();runtime=undefined
 }finally{runtime?.shutdown();store.close()}
 const missing=new StateStore(':memory:')
 try{seed(missing,[]);const r=new TerminalRuntime(connection,missing,noVenue);try{r.pause();assert.equal(executor(missing).comparison().awaitingSimulation,1);assert.equal(executor(missing).comparison().matched,0)}finally{r.shutdown()}}finally{missing.close()}
})

test('conflicting retained exits never overwrite an already settled comparison',()=>{
 const store=new StateStore(':memory:');let runtime:TerminalRuntime|undefined
 try{
  seed(store,[trade]);executor(store)
  const prior=JSON.stringify({...trade,netPnl:-.4,netReturnPct:-.2})
  store.database.prepare('INSERT INTO execution_simulation VALUES(?,?)').run(key,prior)
  runtime=new TerminalRuntime(connection,store,noVenue)
  runtime.pause()
  assert.equal(store.database.prepare('SELECT data FROM execution_simulation WHERE position_id=?').get(key)!.data,prior)
  assert.equal(store.intents().length,0)
 }finally{runtime?.shutdown();store.close()}
})

test('a retained close from another lane fails recovery before funding and cannot bypass the next ownership check',()=>{
 const store=new StateStore(':memory:');let runtime:TerminalRuntime|undefined
 try{
  seed(store,[{...trade,configId:'different-source'}]);runtime=new TerminalRuntime(connection,store,noVenue)
  assert.throws(()=>runtime!.pause(),/escaped its exact owned lane/)
  assert.throws(()=>runtime!.pause(),/ownership was lost/)
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM execution_simulation').get()!.n,0)
  assert.equal(store.intents().length,0)
 }finally{runtime?.shutdown();store.close()}
})
