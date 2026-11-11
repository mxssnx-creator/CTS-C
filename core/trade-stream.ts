import {gunzipSync} from 'node:zlib'
import type {Candle} from './types'
import type {ConnectionId} from './connections'

export interface ObservedTrade {id:string|null;symbol:string;timestamp:number;price:number;quantity:number}
export interface TradeBar extends Candle {trades:number;source:'bingx-trades';complete:boolean}
export const TRADE_STREAM_URLS:Record<ConnectionId,string>={
  'bingx-x02':'wss://vst-open-api-ws.bingx.com/swap-market',
  'bingx-x01':'wss://open-api-swap.bingx.com/swap-market',
}
export function decodeTradeMessage(data:string|ArrayBuffer):'Ping'|ObservedTrade[]{
  const text=typeof data==='string'?data:gunzipSync(Buffer.from(data),{maxOutputLength:2_000_000}).toString('utf8')
  if(text==='Ping')return 'Ping'
  const value=JSON.parse(text)
  if(value.code&&value.code!==0)throw new Error(`Trade subscription rejected (${value.code})`)
  if(!value.dataType?.endsWith('@trade'))return []
  if(!Array.isArray(value.data))throw new Error('Invalid trade array')
  return value.data.map((row:any)=>{
    const trade={id:row.t??null,symbol:row.s,timestamp:Number(row.T),price:Number(row.p),quantity:Number(row.q)}
    if((trade.id!==null&&(typeof trade.id!=='string'||!trade.id))||trade.symbol!==value.dataType.split('@')[0]||
       !/^[A-Z0-9]+-USDT$/.test(trade.symbol)||!Number.isSafeInteger(trade.timestamp)||trade.timestamp<=0||
       !Number.isFinite(trade.price)||trade.price<=0||!Number.isFinite(trade.quantity)||trade.quantity<=0)throw new Error('Invalid trade record')
    return trade
  }).sort((a:ObservedTrade,b:ObservedTrade)=>a.timestamp-b.timestamp)
}

/** Only observed trades form bars. Partial connection buckets and gaps are never filled. */
export class TradeBarBuilder {
  private rows=new Map<string,{bar:TradeBar;last:number;ids:Set<string>}>()
  duplicates=0;late=0;gaps=0
  reset(){this.rows.clear()}
  ingest(trade:ObservedTrade):{accepted:boolean;bar?:TradeBar}{
    const bucket=Math.floor(trade.timestamp/10_000)*10_000
    let state=this.rows.get(trade.symbol)
    if(trade.id!==null&&state?.ids.has(trade.id)){this.duplicates++;return {accepted:false}}
    if(state&&trade.timestamp<state.last){this.late++;return {accepted:false}}
    let bar:TradeBar|undefined
    if(!state||bucket+10_000!==state.bar.timestamp){
      const contiguous=!!state&&bucket===state.bar.timestamp
      if(state){bar=state.bar;if(!contiguous){bar.complete=false;this.gaps++}}
      state={bar:{timestamp:bucket+10_000,open:trade.price,high:trade.price,low:trade.price,close:trade.price,volume:0,trades:0,source:'bingx-trades',complete:contiguous},last:trade.timestamp,ids:state?.ids??new Set()}
      this.rows.set(trade.symbol,state)
    }
    if(trade.id!==null)state.ids.add(trade.id)
    if(state.ids.size>4096)state.ids.delete(state.ids.values().next().value!)
    state.last=trade.timestamp;state.bar.high=Math.max(state.bar.high,trade.price);state.bar.low=Math.min(state.bar.low,trade.price)
    state.bar.close=trade.price;state.bar.volume+=trade.quantity;state.bar.trades++
    return {accepted:true,bar}
  }
}

/** Connection-local bounded FIFO; overflow invalidates continuity instead of skipping price paths silently. */
export class BingxTradeStream {
  private sockets:WebSocket[]=[]
  private retry?:ReturnType<typeof setTimeout>
  private watchdog?:ReturnType<typeof setInterval>
  private queue:ObservedTrade[]=[]
  private running=false
  private lastMessages=new Map<WebSocket,number>()
  private generation=0
  private symbols:string[]=[]
  readonly status={connected:false,received:0,idless:0,reconnects:0,overflows:0,lastTradeAt:0,error:null as string|null,generation:0}
  constructor(readonly connectionId:ConnectionId,private readonly makeSocket:(url:string)=>WebSocket=url=>new WebSocket(url)){}
  start(symbols:string[]){
    this.stop();this.running=true;this.symbols=[...new Set(symbols)];this.connect()
  }
  private connect(){
    if(!this.running)return
    const generation=++this.generation;this.status.generation=generation;this.queue=[];this.lastMessages.clear()
    let opened=0
    // Keep per-connection subscriptions bounded; 50 symbols use three sockets.
    for(let start=0;start<this.symbols.length;start+=20){
      const chunk=this.symbols.slice(start,start+20),socket=this.makeSocket(TRADE_STREAM_URLS[this.connectionId]);socket.binaryType='arraybuffer';this.sockets.push(socket)
      this.lastMessages.set(socket,Date.now())
      socket.onopen=()=>{if(generation!==this.generation)return;for(const symbol of chunk)socket.send(JSON.stringify({id:`ctsc-${symbol}`,reqType:'sub',dataType:`${symbol}@trade`}));opened++;this.status.connected=opened===Math.ceil(this.symbols.length/20)}
      socket.onmessage=event=>{
        if(generation!==this.generation)return
        try{
          this.lastMessages.set(socket,Date.now())
          const trades=decodeTradeMessage(event.data)
          if(trades==='Ping'){socket.send('Pong');return}
          if(this.queue.length+trades.length>50000){this.status.overflows++;this.restart('Trade queue overflow');return}
          for(const trade of trades)if(this.symbols.includes(trade.symbol)){
            if(trade.timestamp>Date.now()+5000||Date.now()-trade.timestamp>15000){this.restart('Stale trade stream');return}
            this.status.error=null;this.queue.push(trade);this.status.received++;if(trade.id===null)this.status.idless++;this.status.lastTradeAt=trade.timestamp
          }
        }catch(error){this.restart(error instanceof Error?error.message:'Trade stream unavailable')}
      }
      socket.onerror=()=>this.restart('Trade WebSocket transport unavailable')
      socket.onclose=()=>{if(generation===this.generation)this.restart('Trade WebSocket disconnected')}
    }
    this.watchdog=setInterval(()=>{if([...this.lastMessages.values()].some(last=>Date.now()-last>30_000))this.restart('Trade WebSocket heartbeat timeout')},5000);this.watchdog.unref?.()
  }
  private restart(reason:string){
    if(!this.running||this.retry)return
    this.status.error=reason;this.status.connected=false;this.status.reconnects++;this.generation++;this.status.generation=this.generation;this.queue=[]
    clearInterval(this.watchdog);for(const socket of this.sockets){socket.onclose=null;socket.onerror=null;socket.close()}this.sockets=[]
    this.retry=setTimeout(()=>{this.retry=undefined;this.connect()},2000);this.retry.unref?.()
  }
  drain(limit=10000):ObservedTrade[]{return this.queue.splice(0,limit).sort((a,b)=>a.timestamp-b.timestamp)}
  stop(){this.running=false;this.generation++;this.status.generation=this.generation;this.status.connected=false;clearTimeout(this.retry);this.retry=undefined;clearInterval(this.watchdog);for(const socket of this.sockets){socket.onclose=null;socket.onerror=null;socket.close()}this.sockets=[];this.queue=[]}
}
