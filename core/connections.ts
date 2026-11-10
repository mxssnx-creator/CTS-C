export const CONNECTIONS=[
  {id:'bingx-x02',name:'X02',exchange:'bingx',demo:true,environment:'BingX VST'},
  {id:'bingx-x01',name:'X01',exchange:'bingx',demo:false,environment:'BingX mainnet'},
] as const
export type ConnectionId=typeof CONNECTIONS[number]['id']
export function connectionInfo(id:unknown='bingx-x02'){
 const found=CONNECTIONS.find(c=>c.id===id)
 if(!found)throw new Error('Unknown connection; choose bingx-x02 or bingx-x01')
 return found
}
