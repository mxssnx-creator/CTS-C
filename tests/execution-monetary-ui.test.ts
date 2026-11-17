import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ExecutionLedger, type ExecutionSnapshot} from '../components/terminal/execution-ledger'

test('execution ledger distinguishes return PF from monetary PF for the same lots',()=>{
 const pf={closed:304,incomplete:0,profitFactor:1.63,pfState:'finite' as const,monetaryProfitFactor:.588,monetaryPfState:'finite' as const}
 const execution:ExecutionSnapshot={lots:[],intents:[],summary:{configured:true,environment:'test',intents:{},ownedLots:0,realizedGrossPnl:0,fees:0,realizedNetPnl:-.47,accounting:'Test lots',executionPF:pf,validatedExecutionPF:pf}}
 const html=renderToStaticMarkup(createElement(ExecutionLedger,{execution}))
 assert.match(html,/Validated return PF/);assert.match(html,/Validated monetary PF/)
 assert.match(html,/1\.630/);assert.match(html,/0\.588/)
 assert.match(html,/different lot sizes can make them diverge/)
})
