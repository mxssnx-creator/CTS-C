/** Root-run only: observe a naturally triggered minimum-size VST bracket. */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { BingxVstClient, protectionOrders, stableClientOrderId, type OrderInput, type VenueOrder, type VenuePosition } from "../core/bingx"
import { StateStore } from "../core/store"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = (order: VenueOrder) => ["FILLED","CANCELED","CANCELLED","EXPIRED","REJECTED"].includes(order.status)
const inventory = (positions: VenuePosition[], orders: VenueOrder[]) => JSON.stringify({positions:positions.map(p=>`${p.positionId}:${p.symbol}:${p.direction}:${p.quantity}`).sort(),orders:orders.map(o=>o.orderId).sort()})
async function main() {
  if (!process.argv.includes("--execute")) throw new Error("Pass --execute for the explicitly authorized VST trigger diagnostic")
  const client = new BingxVstClient()
  if (!client.configured) throw new Error("Dedicated x02 credentials unavailable")
  const [contracts,quotes,baselinePositions,baselineOrders,mode] = await Promise.all([client.contracts(),client.quotes(),client.positions(),client.openOrders(),client.positionMode()])
  if (mode !== "hedge") throw new Error("Hedge mode is required; no account settings changed")
  const occupied = new Set([...baselinePositions,...baselineOrders].map(row=>row.symbol))
  const contract = ["XRP-USDT","DOGE-USDT","ADA-USDT","SOL-USDT"].map(symbol=>contracts.find(row=>row.symbol===symbol)).find(row=>row&&!occupied.has(row.symbol)&&quotes.some(q=>q.symbol===row.symbol))
  if (!contract) throw new Error("No empty diagnostic symbol is available")
  const price = quotes.find(row=>row.symbol===contract.symbol)!.price, scale=10**contract.quantityPrecision, tick=10**-contract.pricePrecision
  const quantity=Math.ceil(Math.max(contract.minQuantity,contract.minNotional/price)*scale-1e-9)/scale
  const runId=`trigger-${randomUUID()}`, startedAt=Date.now(), baseline=inventory(baselinePositions,baselineOrders)
  const store=new StateStore(path.resolve(process.env.CTS_DATA_DIR||".data",`${runId}.sqlite`))
  const parents=new Map<string,VenueOrder>()
  let entryInput:OrderInput|null=null, entryFilled=0, entryPositionId:string|null=null, triggered=false
  const observation:Record<string,unknown>[]=[]
  async function send(input:OrderInput) {
    if (!store.claimIntent(input.clientOrderId,{runId,input})) throw new Error("This diagnostic write is already reserved; reconcile before any replay")
    const outcome=await client.submitOrder(input);store.resolveIntent(input.clientOrderId,outcome.status,{outcome})
    if(outcome.status!=="accepted")throw new Error(`${input.type} ${outcome.status}: ${outcome.reason}`)
    return outcome.order
  }
  async function confirm(order:VenueOrder) {
    for(let poll=0;poll<15;poll++){const current=await client.orderById(contract!.symbol,order.orderId);if(terminal(current)){if(current.filledQuantity>0&&current.averagePrice>0)return current;throw new Error(`Order ended ${current.status} without a fill`)}await pause(250)}
    throw new Error("Entry fill is not confirmed; retain journal for reconciliation")
  }
  async function evidence() {
    const oldParents=[]
    for(const [clientId,parent]of parents){try{const current=await client.orderById(contract!.symbol,parent.orderId);if(current.filledQuantity>0)triggered=true;oldParents.push({clientId,parentId:parent.orderId,status:current.status,orderId:current.orderId,filledQuantity:current.filledQuantity,averagePrice:current.averagePrice,responseFields:current.responseFields})}catch(error){oldParents.push({clientId,parentId:parent.orderId,error:error instanceof Error?error.message:"Read unavailable"})}}
    const history=await client.historyEvidence(contract!.symbol,startedAt-5000,Date.now())
    observation.push({oldParents,history});store.set("trigger-evidence",observation)
  }
  async function cleanup() {
    if(entryInput&&entryFilled===0){const recovered=await client.orderByClientId(contract!.symbol,entryInput.clientOrderId);if(recovered){if(!terminal(recovered))await client.cancelOwnedOrder(contract!.symbol,entryInput.clientOrderId,recovered.orderId);const final=await client.orderById(contract!.symbol,recovered.orderId);entryFilled=final.filledQuantity;store.resolveIntent(entryInput.clientOrderId,"accepted",{outcome:{status:"accepted",clientOrderId:entryInput.clientOrderId,order:final,recovered:true}})}}
    const open=await client.openOrders(contract!.symbol), openIds=new Set(open.map(row=>row.orderId))
    for(const [clientId,parent]of parents){if(!openIds.has(parent.orderId))continue;const result=await client.cancelOwnedOrder(contract!.symbol,clientId,parent.orderId);if(result.status!=="accepted"||!terminal(result.order))throw new Error("Known sibling cancellation is not confirmed")}
    const positions=await client.positions(contract!.symbol)
    if(positions.length){const position=positions.find(row=>row.direction==="LONG");if(!position||positions.length!==1||position.quantity>entryFilled+1e-10||(entryPositionId&&position.positionId!==entryPositionId))throw new Error("Inventory no longer matches the isolated diagnostic lot; no aggregate close sent")
      const close=await send({symbol:contract!.symbol,side:"SELL",positionSide:"LONG",quantity:position.quantity.toFixed(contract!.quantityPrecision),type:"MARKET",reduceOnly:true,clientOrderId:stableClientOrderId(runId,"cleanup-close")});await confirm(close)}
    const [p,o]=await Promise.all([client.positions(),client.openOrders()])
    if(store.unresolvedIntents().length||inventory(p,o)!==baseline)throw new Error("Final inventory or unknown intent still requires reconciliation")
  }
  try {
    entryInput={symbol:contract.symbol,side:"BUY",positionSide:"LONG",type:"MARKET",quantity:quantity.toFixed(contract.quantityPrecision),clientOrderId:stableClientOrderId(runId,"entry")}
    const entry=await confirm(await send(entryInput));entryFilled=entry.filledQuantity
    const position=(await client.positions(contract.symbol)).find(row=>row.direction==="LONG")
    if(!position||Math.abs(position.quantity-entryFilled)>1e-10)throw new Error("Confirmed entry inventory is not isolated")
    entryPositionId=position.positionId
    const center=position.markPrice>0?position.markPrice:entry.averagePrice, distance=Math.max(center*0.0005,tick*3)
    const stopLoss=Math.floor((center-distance)/tick)*tick,takeProfit=Math.ceil((center+distance)/tick)*tick
    const inputs=protectionOrders({symbol:contract.symbol,direction:"LONG",quantity:entryFilled.toFixed(contract.quantityPrecision),clientOrderId:stableClientOrderId(runId,"protection"),stopLoss:stopLoss.toFixed(contract.pricePrecision),takeProfit:takeProfit.toFixed(contract.pricePrecision)})
    for(const input of inputs){const order=await send(input);parents.set(input.clientOrderId,order)}
    console.log(JSON.stringify({progress:"observing",runId,symbol:contract.symbol,quantity:entryFilled,stopLoss,takeProfit,maxObservationSeconds:120}))
    const deadline=Date.now()+120_000
    while(Date.now()<deadline){const current=await client.positions(contract.symbol);const remaining=current.filter(row=>row.direction==="LONG").reduce((sum,row)=>sum+row.quantity,0);if(remaining<entryFilled-1e-10){triggered=true;console.log(JSON.stringify({progress:"native-reduction-observed",remaining}));break}await pause(Math.min(2000,Math.max(0,deadline-Date.now())))}
    await evidence();await cleanup()
    console.log(JSON.stringify({success:true,environment:"BingX VST",runId,triggered,observation,cleanup:"verified equal to baseline",residualPositions:0,residualOrders:0,foreignInventoryPreserved:true},null,2))
  } catch(error) {
    let cleanupStatus="requires reconciliation using the isolated trigger journal"
    try{await evidence()}catch{/* Evidence must not prevent owned cleanup. */}
    try{await cleanup();cleanupStatus="verified equal to baseline"}catch{/* Never claim unverified cleanup. */}
    console.error(JSON.stringify({success:false,environment:"BingX VST",runId,triggered,observation,cleanup:cleanupStatus,reason:error instanceof Error?error.message:"Diagnostic failed"},null,2));process.exitCode=1
  } finally {store.close()}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Diagnostic setup failed");process.exitCode=1})
