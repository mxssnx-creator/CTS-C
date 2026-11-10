import {BingxVstClient,demoCredentials} from '../core/bingx'
async function main(){
const credentials=demoCredentials()
if(!credentials){console.log(JSON.stringify({connection:'bingx-x02',environment:'VST',ready:false,reason:'Dedicated credentials unavailable',ordersSubmitted:0}));process.exitCode=2}
else{try{const c=new BingxVstClient(credentials);const [balance,positions,orders]=await Promise.all([c.balance(),c.positions(),c.openOrders()]);console.log(JSON.stringify({connection:'bingx-x02',environment:'VST',ready:true,asset:balance.asset,positions:positions.length,orders:orders.length,ordersSubmitted:0}))}catch{console.log(JSON.stringify({connection:'bingx-x02',environment:'VST',ready:false,reason:'Exchange verification failed',ordersSubmitted:0}));process.exitCode=1}}
}
void main()
