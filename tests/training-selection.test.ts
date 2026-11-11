import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateStrategyCatalog} from '../core/catalog'
import {selectTrainingConfigurations} from '../core/training-selection'
import type {LaneState} from '../core/types'

test('prehistory selection combines own long/short Base evidence and cannot borrow another symbol, account or stage',()=>{
 const configs=generateStrategyCatalog('bingx-x02',{strategyTpSteps:[3,5],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['MA_Cross']})
 const lane=(index:number,overrides:Partial<LaneState>={}):LaneState=>({id:'lane-'+index,configId:configs[index].id,config:configs[index],symbol:'BTC-USDT',stage:'base',coordination:'normal',direction:'long',samples:[],closedCount:10,grossProfit:12,grossLoss:10,netPnl:2,wins:6,lastTimestamp:1,admissionCount:10,...overrides})
 const own=[lane(0),lane(0,{direction:'short'}),lane(1)],foreign=[lane(1,{symbol:'ETH-USDT',closedCount:100,grossProfit:1000,grossLoss:1}),lane(1,{config:{...configs[1],connectionId:'bingx-x01'},closedCount:100,grossProfit:1000,grossLoss:1}),lane(1,{stage:'real',closedCount:100,grossProfit:1000,grossLoss:1}),lane(1,{coordination:'dca',closedCount:100,grossProfit:1000,grossLoss:1})]
 const result=selectTrainingConfigurations([...own,...foreign],configs,'BTC-USDT',20,1.1,1)
 assert.deepEqual(result.selectedIds,[configs[0].id]);assert.equal(result.candidates.find(c=>c.id===configs[1].id)!.closes,10)
 const frozen=JSON.stringify(result);own[2].closedCount=200;own[2].grossProfit=2000;assert.equal(JSON.stringify(result),frozen);assert.deepEqual(selectTrainingConfigurations(own,configs,'BTC-USDT',20,1.1,1).selectedIds,[configs[1].id])
 assert.throws(()=>selectTrainingConfigurations(own,configs,'BTC-USDT',0));assert.throws(()=>selectTrainingConfigurations(own,configs,'BTC-USDT',20,.9))
})
