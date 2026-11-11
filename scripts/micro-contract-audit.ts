/** Read-only feasibility audit for the smallest Micro distances and order sizes. */
import {readFile,writeFile} from 'node:fs/promises'
import {BingxVstClient} from '../core/bingx'
import {resolveTradingCostPct} from '../core/metrics'
const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
async function main(){
 const manifest=JSON.parse(await readFile(arg('--manifest','.data/micro-study/manifest.json'),'utf8'))
 const venue=new BingxVstClient(),[contracts,quotes]=await Promise.all([venue.contracts(),venue.quotes()])
 const cost=resolveTradingCostPct({makerFeePct:manifest.fee.maker*100,takerFeePct:manifest.fee.taker*100,slippagePctOfFees:10})
 const rows=manifest.symbols.map((symbol:string)=>{
  const contract=contracts.find(c=>c.symbol===symbol),quote=quotes.find(q=>q.symbol===symbol)
  if(!contract||!quote)throw Error(`No observed contract/quote for ${symbol}`)
  const scale=10**contract.quantityPrecision,tick=10**-contract.pricePrecision
  const size=(ratio:number)=>Math.ceil(Math.max(1/quote.price,contract.minQuantity/ratio,contract.minNotional/quote.price/ratio)*scale-1e-9)/scale*quote.price
  const configurations=[]
  for(const step of [2,3,4,5])for(let ri=2;ri<=16;ri++)for(const direction of ['long','short']){
   const sign=direction==='long'?1:-1,tp=cost*step,sl=tp*ri/10
   const stop=Number((quote.price*(1-sign*sl/100)).toFixed(contract.pricePrecision)),target=Number((quote.price*(1+sign*tp/100)).toFixed(contract.pricePrecision))
   configurations.push({step,ratio:ri/10,direction,tpPct:tp,slPct:sl,roundedStop:stop,roundedTarget:target,representable:sign*(quote.price-stop)>0&&sign*(target-quote.price)>0,oneTickStop:quote.price*sl/100+Number.EPSILON>=tick,trailWidthTicks:quote.price*sl*.5/100/tick})
  }
  return {symbol,quote,contract,normalMinimumNotional:size(1),dcaPointTwoMinimumNotional:size(.2),normalFits10:size(1)<=10+1e-10,dcaPointTwoFits10:size(.2)<=10+1e-10,representable:configurations.filter(c=>c.representable).length,oneTickStops:configurations.filter(c=>c.oneTickStop).length,checked:configurations.length,configurations}
 })
 const result={generatedAt:new Date().toISOString(),environment:'BingX VST',orderWrites:0,costPct:cost,symbols:rows.length,checked:rows.reduce((n:number,r:any)=>n+r.checked,0),representable:rows.reduce((n:number,r:any)=>n+r.representable,0),normalFits10:rows.filter((r:any)=>r.normalFits10).length,dcaPointTwoFits10:rows.filter((r:any)=>r.dcaPointTwoFits10).length,rows,note:'Observed quote/contract feasibility, not exchange acceptance or simulated profitability. Minima and rounding can change. Exact fill-based protection is reconciled by the executor.'}
 await writeFile(arg('--output','.data/micro-contract-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined}))
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Contract audit failed');process.exitCode=1})
