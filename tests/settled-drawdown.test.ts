import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settledDrawdown } from '../scripts/settled-drawdown'

test('settled drawdown groups simultaneous closes before measuring chronological cash losses',()=>{
 const flows:[[number,number],[number,number],[number,number],[number,number]]=[[30,-1],[20,-3],[10,2],[20,1]]
 assert.deepEqual(settledDrawdown(flows),{netPnl:-1,peakToTrough:3,clocks:3})
 assert.deepEqual(settledDrawdown(flows.slice().reverse()),{netPnl:-1,peakToTrough:3,clocks:3})
 assert.deepEqual(settledDrawdown([]),{netPnl:0,peakToTrough:0,clocks:0})
 assert.throws(()=>settledDrawdown([[10,NaN]]),/Invalid settled/)
 assert.throws(()=>settledDrawdown([[10,Number.MAX_VALUE],[10,Number.MAX_VALUE]]),/Invalid settled/)
 assert.throws(()=>settledDrawdown([[10,Number.MAX_VALUE],[20,-Number.MAX_VALUE],[30,-Number.MAX_VALUE]]),/Invalid settled/)
})
