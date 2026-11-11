import {BingxTradeStream,TradeBarBuilder} from './trade-stream'
import { randomUUID } from 'node:crypto'
import { TradingEngine, DEFAULT_ENGINE_SETTINGS, validateEngineSettings,validateObservedCandles } from './engine'
import { connectionClient, connectionCredentials, stableClientOrderId,type BingxClient } from './bingx'
import {CONNECTIONS,connectionInfo,type ConnectionId} from './connections'
import { planExecutionIntents } from './runtime-policy'
import { closedHistory, planHistory, validateHistory, type HistoryPlan } from './history'
import { DemoExecutor } from './executor'
import { getStore,type StateStore } from './store'
import type { Candle, EngineSettings, EngineEvent } from './types'
import { generateStrategyCatalog } from './catalog'
import {flatEngineSettings,validateConfiguration} from './settings-schema'

interface Control { running: boolean; exchangeExecution: boolean; warmed: string[]; symbolCount: number; historyCandles:number; lastTick: number | null; lastError: string | null;feeReadFailures:string[];feeCheckedAt:number|null }
interface Bar { bucket: number; candle: Candle; lastObservation: number }
interface HistoryJob {data?:Candle[];error?:string;plan?:HistoryPlan;live?:boolean;validated?:boolean;offset?:number;cursor?:number|null}
const DEFAULT_CONTROL: Control = { running:false,exchangeExecution:false,warmed:[],symbolCount:100,historyCandles:4320,lastTick:null,lastError:null,feeReadFailures:[],feeCheckedAt:null }
function retainEvents(target:EngineEvent[],source:readonly EngineEvent[],limit=5000){
  if(source.length>=limit)target.length=0
  for(let i=Math.max(0,source.length-limit);i<source.length;i++)target.push(source[i])
  if(target.length>limit)target.splice(0,target.length-limit)
}
export class TerminalRuntime {
  engine: TradingEngine
  control: Control
  private tradeStream?:BingxTradeStream
  private tradeBars=new TradeBarBuilder()
  private tradeGeneration=0
  private tradeTimer?:ReturnType<typeof setTimeout>
  private tradeSerialPending=false
  private tradeBarsRecorded=0
  private timer?: ReturnType<typeof setTimeout>
  private readonly owner=randomUUID()
  private leased=false
  private leaseRenewedAt=0
  private leaseLost=false
  private hydratedCheckpointToken:string|null=null
  private heartbeat?:ReturnType<typeof setInterval>
  private checkpointAt=0
  private bufferedEvents:EngineEvent[]=[]
  private sequence: Promise<unknown> = Promise.resolve()
  private executionTask?:Promise<void>
  private quoteTask?:Promise<void>
  private quoteResult?:Awaited<ReturnType<BingxClient["quotes"]>>
  private quoteError:Error|null=null
  private quoteGeneration=0
  private accountTask?:Promise<void>
  private accountRetryAt=0
  private accountGeneration=0
  private accountError:string|null=null
  private bars = new Map<string,Bar>()
  private warmJobs=new Map<string,HistoryJob>()
  private warmRetryAt=new Map<string,number>()
  private marks = new Map<string,{price:number;timestamp:number}>()
  private client:BingxClient
  private executor:DemoExecutor
  constructor(readonly connectionId:ConnectionId='bingx-x02',readonly store:StateStore=getStore(connectionId),private readonly createClient:(id:ConnectionId)=>BingxClient=connectionClient) {
    connectionInfo(connectionId)
    this.client=this.createClient(connectionId)
    this.executor=new DemoExecutor(this.store,this.client,{connectionId,beforeSubmit:()=>this.ensureLease(),validateIntent:intent=>this.validateLiveIntent(intent)})
    const restored = this.store.loadEngineState()
    this.hydratedCheckpointToken=this.store.loadedCheckpointToken()
    this.engine = restored ? TradingEngine.fromOwnedCheckpoint(restored) : new TradingEngine({...DEFAULT_ENGINE_SETTINGS,connectionId})
    if(this.engine.settings.connectionId!==connectionId)throw new Error('Engine checkpoint belongs to another connection')
    this.control = { ...DEFAULT_CONTROL, ...this.store.get<Control>('control'), warmed: [] }
  }
  private validateLiveIntent(intent:import('./types').ExecutionIntent){
    if(!this.control.exchangeExecution||!this.engine.isLiveIntentEligible(intent.positionId))throw new Error('Entry/add signal is no longer active or its qualification changed; no exchange order submitted')
  }
  private ensureLease() {
    if(this.leaseLost)throw new Error('Execution ownership was lost; restart this process to reload durable state')
    if(this.leased){
      const now=Date.now(),renew=now-this.leaseRenewedAt>=1000
      if(renew?this.store.renewLease(this.owner):this.store.ownsLease(this.owner)){if(renew)this.leaseRenewedAt=now;return}
      this.leaseLost=true;this.control.running=false;clearTimeout(this.timer);throw new Error('Another runtime owns execution or this runtime lease expired')
    }
    let acquired=false
    for(let attempt=0;attempt<3;attempt++){
      if(!this.store.acquireLease(this.owner))throw new Error('Another CTS-C process owns this data directory')
      if(this.hydratedCheckpointToken===this.store.checkpointToken()){
        if(!this.store.renewLease(this.owner)){this.leaseLost=true;throw new Error('Runtime ownership expired during checkpoint verification')}
        acquired=true;break
      }
      this.store.releaseLease(this.owner)
      // Hydration can take longer than a lease on a large journal. Do it unowned, then
      // verify the exact checkpoint generation after reacquiring before any mutation.
      const restored=this.store.loadEngineState()
      if(restored){if(restored.settings.connectionId!==this.connectionId)throw new Error('Engine checkpoint belongs to another connection');this.engine=TradingEngine.fromOwnedCheckpoint(restored)}
      this.hydratedCheckpointToken=this.store.loadedCheckpointToken()
    }
    if(!acquired)throw new Error('Checkpoint changed repeatedly before execution ownership')
    this.leased=true
    this.leaseRenewedAt=Date.now()
    this.heartbeat=setInterval(()=>{try{this.ensureLease()}catch(error){this.control.lastError=error instanceof Error?error.message:'Ownership lost';clearInterval(this.heartbeat)}},5000)
    this.heartbeat.unref?.()
    this.control={...this.control,...this.store.get<Control>('control'),warmed:[]}
  }
  async quiesce(){
    let failure:unknown
    try{await this.serial(async()=>this.stop())}catch(error){failure=error}
    await this.executionTask
    await this.serial(async()=>{})
    if(failure)throw failure
  }
  assertOwnership(){this.ensureLease()}
  /** Offline observed-history preparation, with bounded work and a checkpoint
   * per symbol. It cannot enable entries or silently renew a lost lease. */
  async warmObservedHistory(symbol:string,candles:Candle[]){
    if(this.control.running||this.control.exchangeExecution)throw new Error('Offline history warmup requires a stopped runtime')
    validateObservedCandles(candles)
    const latest=Math.floor(Date.now()/60000)*60000
    if(candles.some((bar,i)=>bar.timestamp>latest||bar.timestamp%60000!==0||(i>0&&bar.timestamp-candles[i-1].timestamp!==60000)))throw new Error('Warmup requires complete contiguous one-minute observations')
    for(let offset=0;offset<candles.length;offset+=8){
      this.ensureLease()
      this.engine.processCandles(symbol,candles.slice(offset,offset+8),{allowExecution:false,eventLimit:0})
      await new Promise<void>(resolve=>setImmediate(resolve))
    }
    this.persist()
  }
  shutdown(){this.tradeStream?.stop();clearTimeout(this.tradeTimer);clearInterval(this.heartbeat);if(this.leased&&!this.leaseLost&&this.store.ownsLease(this.owner)){this.persist();this.store.releaseLease(this.owner)}clearTimeout(this.timer);this.leased=false;this.leaseLost=true;this.control.running=false}
  serial<T>(operation:()=>Promise<T>): Promise<T> { const next=this.sequence.catch(()=>{}).then(operation); this.sequence=next; return next }
  private persist(events: EngineEvent[] = [],force=true) {
    this.ensureLease();retainEvents(this.bufferedEvents,events)
    const cold=this.control.warmed.length<this.engine.managedSymbols().length
    const exposed=this.executor.lots?.().some(lot=>lot.quantity>1e-10)??false
    const interval=cold&&!exposed?30000:5000
    if(!force&&Date.now()-this.checkpointAt<interval&&!this.engine.pendingIntents().length)return
    const metadata=this.engine.checkpointMetadata(),settings=this.engine.settings
    if(this.store.hasLaneCheckpoint())this.store.saveLaneCheckpoint(metadata,this.engine.checkpointLanes(),this.bufferedEvents,settings,()=>this.ensureLease())
    else this.store.migrateLaneCheckpoint(metadata,this.engine.checkpointLanes(true),this.bufferedEvents,settings,()=>this.ensureLease())
    this.engine.checkpointSaved();this.store.set('control',this.control)
    this.bufferedEvents=[];this.checkpointAt=Date.now()
  }
  async start() {
    this.ensureLease()
    if(!connectionCredentials(this.connectionId))throw new Error(`Dedicated ${connectionInfo(this.connectionId).name} credentials are unavailable on the server.`)
    this.quoteGeneration++;this.quoteResult=undefined;this.quoteError=null
    this.accountGeneration++;this.accountError=null;this.accountRetryAt=0
    this.client = this.createClient(this.connectionId)
    this.executor = new DemoExecutor(this.store,this.client,{connectionId:this.connectionId,beforeSubmit:()=>this.ensureLease(),validateIntent:(intent)=>this.validateLiveIntent(intent)})
    const [balance,contracts,quotes] = await Promise.all([this.client.balance(),this.client.contracts(),this.client.quotes()])
    this.store.set('account',{...balance,updatedAt:Date.now(),source:connectionInfo(this.connectionId).environment})
    const available=new Set(quotes.filter(q=>q.price>0).map(q=>q.symbol))
    const priority=['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','BCH-USDT','DOGE-USDT']
    const symbols=[...priority,...contracts.map(c=>c.symbol)].filter((s,i,a)=>a.indexOf(s)===i&&available.has(s)).slice(0,this.control.symbolCount)
    if(!symbols.length)throw new Error('No tradable contracts returned for this connection')
    this.ensureLease()
    const settings=this.engine.settings
    // Removed symbols remain managed until their owned paper positions close.
    this.engine.updateSettings({...settings,symbols})
    const symbolFees:NonNullable<EngineSettings['symbolFees']>={},feeReadFailures:string[]=[]
    for(const symbol of symbols)if(settings.symbolFees?.[symbol])symbolFees[symbol]=settings.symbolFees[symbol]
    try{
      const fee=await this.client.commission()
      for(const symbol of symbols)symbolFees[symbol]={makerFeePct:Math.max(0,fee.maker*100),takerFeePct:fee.taker*100}
    }catch{for(const symbol of symbols)feeReadFailures.push(symbol)}
    this.engine.updateSettings({symbolFees})
    this.control={...this.control,running:true,exchangeExecution:true,lastError:null,feeReadFailures,feeCheckedAt:Date.now()}
    this.persist()
    this.startTradeStream()
    this.schedule()
  }
  pause() { this.ensureLease();this.control.exchangeExecution=false; this.persist() }
  stop() { this.ensureLease();this.tradeStream?.stop();clearTimeout(this.tradeTimer);this.control.running=false;this.control.exchangeExecution=false;clearTimeout(this.timer);this.timer=undefined;this.persist() }
  resume() { if(this.control.running){try{this.ensureLease();if(connectionCredentials(this.connectionId)){this.startTradeStream();this.schedule();}else{this.control.running=false;this.control.lastError=`${connectionInfo(this.connectionId).name} credentials unavailable after restart`;this.persist()}}catch(error){this.control.running=false;this.control.lastError=error instanceof Error?error.message:'Runtime ownership unavailable'}} }
  private startTradeStream(){
    this.tradeStream?.stop();clearTimeout(this.tradeTimer)
    if(this.engine.settings.catalog.microTradeStream!==true)return
    this.tradeStream=new BingxTradeStream(this.connectionId)
    this.tradeStream.start(this.engine.managedSymbols())
    this.scheduleTrades()
  }
  private scheduleTrades(){
    if(!this.control.running||!this.tradeStream)return
    this.tradeTimer=setTimeout(()=>{
      if(!this.tradeSerialPending){
        this.tradeSerialPending=true
        void this.serial(async()=>this.consumeTrades()).catch(error=>{this.control.lastError=error instanceof Error?error.message:'Trade processing failed'}).finally(()=>{this.tradeSerialPending=false;this.scheduleTrades()})
      }
    },100)
    this.tradeTimer.unref?.()
  }
  private consumeTrades(){
    if(!this.control.running||!this.tradeStream)return
    this.ensureLease()
    if(this.tradeGeneration!==this.tradeStream.status.generation){this.tradeGeneration=this.tradeStream.status.generation;this.tradeBars.reset()}
    const events:EngineEvent[]=[]
    for(const trade of this.tradeStream.drain()){
      const observed=this.tradeBars.ingest(trade)
      if(!observed.accepted)continue
      if(observed.bar){
        this.store.saveTradeBar(trade.symbol,observed.bar);this.tradeBarsRecorded++
        if(observed.bar.complete){
          // Each micro lane warms on its own observed bars and stage proofs;
          // unrelated minute-history recovery must not block a qualified lane.
          const fresh=Date.now()-trade.timestamp<=15000
          retainEvents(events,this.engine.processCandles(trade.symbol,[observed.bar],{barSeconds:10,allowExecution:fresh&&this.control.exchangeExecution,eventLimit:fresh?5000:0}))
        }
      }
      this.marks.set(trade.symbol,{price:trade.price,timestamp:trade.timestamp})
      retainEvents(events,this.engine.processTick(trade.symbol,trade.price,trade.timestamp,true,this.control.warmed.includes(trade.symbol)?"all":"micro"))
    }
    if(events.length)this.persist(events,false)
    this.pumpExecution()
  }
  /** Wake execution on stream ticks without waiting for the quote/history cycle.
   * One in-flight cycle; venue pacing and durable intent claims still apply. */
  private pumpExecution(reconcile=false){
    if(!this.control.running)return
    this.ensureLease()
    if(!this.executionTask){
        const events:EngineEvent[]=[]
        const pending=this.engine.pendingIntents().filter(i=>this.control.exchangeExecution||i.kind==='close')
        if(!reconcile&&!pending.length)return
        const submittedIntentIds=new Set(pending.filter(i=>this.store.intent(stableClientOrderId(i.connectionId,i.id))).map(i=>i.id))
        const plan=planExecutionIntents(pending,{activePositionIds:this.engine.activePositionIds(),submittedIntentIds,now:Date.now(),limit:1})
        for(const rejection of plan.rejected){this.engine.markExecution(rejection.id,{status:'rejected',error:rejection.error});const intent=pending.find(i=>i.id===rejection.id)!;events.push({type:'execution',laneId:intent.laneId,stage:'live',timestamp:Date.now(),status:'rejected',reason:rejection.error})}
        if(plan.rejected.length)this.persist(events.splice(0))
        this.executionTask=this.executor.process(plan.ready).then(updates=>this.serial(async()=>{
          const pendingById=new Map(this.engine.pendingIntents().map(i=>[i.id,i])),audit:EngineEvent[]=[]
          for(const update of updates)if(update.status!=='unknown'&&pendingById.has(update.id)){this.engine.markExecution(update.id,{...update,status:update.status});audit.push({type:'execution',laneId:pendingById.get(update.id)!.laneId,stage:'live',timestamp:Date.now(),status:update.status,reason:update.error})}
          if(audit.length)this.persist(audit)
        })).catch(error=>{this.control.lastError=error instanceof Error?error.message:'Executor unavailable'}).finally(()=>{this.executionTask=undefined})
      }
  }
  private prefetchHistory() {
    if(!this.control.running)return
    const latest=Math.floor(Date.now()/60000)*60000
    const needed=this.engine.managedSymbols().filter(symbol=>(!this.control.warmed.includes(symbol)||(this.engine.lastProcessedAt(symbol)??latest)<latest)&&!this.warmJobs.has(symbol)&&(this.warmRetryAt.get(symbol)??0)<=Date.now())
    for(const symbol of needed.slice(0,Math.max(0,8-this.warmJobs.size))){
      const job:HistoryJob={};this.warmJobs.set(symbol,job)
      try {
        const plan=job.plan=planHistory(this.control.historyCandles,this.engine.lastProcessedAt(symbol))
        job.live=this.control.warmed.includes(symbol)&&plan.cursor===latest-60000
        if(plan.cursor===plan.cutoff)job.data=[]
        else void closedHistory(this.client,symbol,plan.count,plan.cutoff).then(data=>{job.data=data}).catch(error=>{job.error=error instanceof Error?error.message:'History unavailable'})
      } catch(error){job.error=error instanceof Error?error.message:'History unavailable'}
    }
  }
  private refreshAccount(){
    if(this.accountTask||Date.now()<this.accountRetryAt||Date.now()-(this.store.get<{updatedAt:number}>('account')?.updatedAt??0)<=30000)return
    const generation=this.accountGeneration
    this.accountTask=Promise.resolve().then(()=>this.client.balance()).then(balance=>this.serial(async()=>{
      if(generation!==this.accountGeneration||this.leaseLost||!this.leased||!this.control.running)return
      this.ensureLease()
      this.store.set('account',{...balance,updatedAt:Date.now(),source:connectionInfo(this.connectionId).environment})
      this.accountError=null
    })).catch(error=>{
      this.accountRetryAt=Date.now()+30000
      if(!this.leaseLost&&this.control.running)this.accountError=`Account refresh: ${error instanceof Error?error.message:'unavailable'}`
    }).finally(()=>{this.accountTask=undefined})
  }
  private verifiedQuote(symbol:string,cutoff:number|undefined):boolean{
    const mark=this.marks.get(symbol),now=Date.now()
    return cutoff!==undefined&&Boolean(mark&&mark.timestamp>=cutoff&&mark.timestamp<=now+5000&&now-mark.timestamp<=15000)
  }
  private consumeHistory(events:EngineEvent[],overlapOnly=false){
      const warmed=[...this.warmJobs.entries()].filter(([symbol,job])=>(job.data||job.error)&&(!job.live||this.verifiedQuote(symbol,job.plan?.cutoff))).slice(0,overlapOnly?3:8)
      const batchBegan=performance.now()
      for(const [symbol,job] of warmed){
        if(performance.now()-batchBegan>=100)break
        this.ensureLease()
        try {
          if(job.error)throw new Error(job.error)
          if(job.data){
            if(!job.validated){
              validateObservedCandles(job.data)
              if(job.plan){
                if(this.engine.lastProcessedAt(symbol)!==job.plan.cursor)throw new Error('History cursor changed during recovery')
                validateHistory(symbol,job.data,job.plan)
              }
              job.cursor=this.engine.lastProcessedAt(symbol)
              const cursor=job.cursor
              job.data=job.data.filter(candle=>cursor===null||candle.timestamp>cursor)
              job.offset=0;job.validated=true
            }
            if(this.engine.lastProcessedAt(symbol)!==job.cursor)throw new Error('History cursor changed during a partial recovery')
            const offset=job.offset??0
            while((job.offset??0)<job.data.length&&(job.offset??0)-offset<128&&performance.now()-batchBegan<100){
              const chunk=job.data.slice(job.offset,(job.offset??0)+8)
              const fresh=job.live===true&&job.data.length===1&&job.plan?.cutoff===Math.floor(Date.now()/60000)*60000&&this.verifiedQuote(symbol,job.plan.cutoff)
              retainEvents(events,this.engine.processCandles(symbol,chunk,{allowExecution:fresh&&this.control.exchangeExecution,eventLimit:fresh?5000:0}))
              job.offset=(job.offset??0)+chunk.length;job.cursor=this.engine.lastProcessedAt(symbol)
            }
            if((job.offset??0)>=job.data.length){
              this.warmJobs.delete(symbol)
              if((!job.plan||job.plan.cutoff>=Math.floor(Date.now()/60_000)*60_000)&&!this.control.warmed.includes(symbol))this.control.warmed.push(symbol)
            }else{this.warmJobs.delete(symbol);this.warmJobs.set(symbol,job)}
          }
        } catch(error) {this.warmJobs.delete(symbol);this.control.lastError=`${symbol}: ${error instanceof Error?error.message:'History unavailable'}`;this.warmRetryAt.set(symbol,Date.now()+30000)}
      }
      if(warmed.length)this.persist(events.splice(0),false)
  }
  private schedule() { if(this.timer||!this.control.running)return; const warming=this.control.warmed.length<this.engine.managedSymbols().length;this.timer=setTimeout(()=>{this.timer=undefined;void this.serial(()=>this.tick()).finally(()=>this.schedule())},warming?100:1000);this.timer.unref?.() }
  private async tick() {
    if(!this.control.running)return
    try {
      this.ensureLease()
      const events:EngineEvent[]=[]
      this.prefetchHistory()
      if(!this.quoteTask){
        const generation=this.quoteGeneration
        this.quoteTask=this.client.quotes().then(quotes=>{
          if(generation===this.quoteGeneration){this.quoteResult=quotes;this.quoteError=null}
        }).catch(error=>{if(generation===this.quoteGeneration)this.quoteError=error instanceof Error?error:new Error('Quotes unavailable')}).finally(()=>{this.quoteTask=undefined})
      }
      await Promise.resolve()
      this.consumeTrades()
      const quotes=this.quoteResult??[];this.quoteResult=undefined
      const now=Date.now(), settings=this.engine.settings
      const managed=new Set(this.engine.managedSymbols())
      let dataGap=false
      this.ensureLease()
      for(const quote of quotes) {
        if(!this.control.warmed.includes(quote.symbol)||!managed.has(quote.symbol))continue
        if(!Number.isFinite(quote.price)||quote.price<=0||Date.now()-quote.timestamp>15_000||quote.timestamp>Date.now()+5000)continue
        if((this.marks.get(quote.symbol)?.timestamp??0)<=quote.timestamp)this.marks.set(quote.symbol,{price:quote.price,timestamp:quote.timestamp})
        const bucket=Math.floor(quote.timestamp/60_000)*60_000
        const previous=this.bars.get(quote.symbol)
        if(previous&&bucket>previous.bucket) {
          if(bucket-previous.bucket!==60_000||quote.timestamp-previous.lastObservation>=90_000){
            this.bars.delete(quote.symbol)
            this.control.warmed=this.control.warmed.filter(symbol=>symbol!==quote.symbol)
            this.control.lastError=`${quote.symbol}: market-data gap; recovering closed history`
            dataGap=true
            continue
          }
          // Signal candles come from native, closed OHLCV history, including real volume.
          this.bars.delete(quote.symbol)
        }
        const bar=this.bars.get(quote.symbol)
        if(!bar)this.bars.set(quote.symbol,{bucket,candle:{timestamp:bucket,open:quote.price,high:quote.price,low:quote.price,close:quote.price,volume:0},lastObservation:quote.timestamp})
        else if(quote.timestamp>bar.lastObservation){bar.candle.high=Math.max(bar.candle.high,quote.price);bar.candle.low=Math.min(bar.candle.low,quote.price);bar.candle.close=quote.price;bar.lastObservation=quote.timestamp}
        retainEvents(events,this.engine.processTick(quote.symbol,quote.price,quote.timestamp))
      }
      if(quotes.length)this.control.lastTick=now;if(!dataGap)this.control.lastError=this.quoteError?.message??null
      this.persist(events.splice(0),false)
      this.pumpExecution(true)
      this.prefetchHistory()
      this.consumeHistory(events)
      this.refreshAccount()
    } catch(error) {this.control.lastError=error instanceof Error?error.message:'Exchange processing unavailable';if(this.leased&&!this.leaseLost&&this.store.ownsLease(this.owner))this.store.set('control',this.control)}
  }
  saveFlatSettings(input:Record<string,unknown>) {
    this.ensureLease()
    input=validateConfiguration(input,{partial:true})
    validateConfiguration({...flatEngineSettings(this.engine.settings,this.control),...input})
    const current=this.engine.settings, next=structuredClone(current)
    const catalogKeys=['microTrailRatio','autoPfEnabled','autoPfRatio','autoPfMax','microTradeStream','relationalVolumeRatios','strategyIndicationSources','strategyNormalEnabled','strategyTrailingEnabled','strategyProcessingByRange','strategyEnabledRanges','strategyTpSteps','strategySlRatios','strategyExitModes','strategyIndicationTypes','strategySignalPeriods','strategySignalTimeframes','strategyTpFactor','strategySlFactor','strategyTrailRatio','holdTimeFactor','makerFeePct','takerFeePct','slippagePctOfFees']
    const gateMap:Record<string,['stageLastN'|'stageMinPF','base'|'main'|'real']>={prevPosWindow:['stageLastN','base'],mainEvalPosCount:['stageLastN','main'],realEvalPosCount:['stageLastN','real'],baseProfitFactor:['stageMinPF','base'],mainProfitFactor:['stageMinPF','main'],realProfitFactor:['stageMinPF','real']}
    for(const [key,value] of Object.entries(input)) {
      if(key==='stageBlocks'){next.stageBlocks=structuredClone(value) as EngineSettings['stageBlocks'];continue}
      if(key==='stageGateMode'){next.stageGateMode=value as EngineSettings['stageGateMode'];continue}
      if(key==='liveEntryMode'){next.liveEntryMode=value as EngineSettings['liveEntryMode'];continue}
      if(catalogKeys.includes(key)){next.catalog[key]=value;continue}
      if(gateMap[key]){const[group,stage]=gateMap[key];next[group][stage]=Number(value);continue}
      if(key==='historyCandles'){if(!Number.isInteger(value)||Number(value)<100||Number(value)>4320)throw new Error('History candles must be 100..4320');continue}
      if(key==='symbolCount'){if(!Number.isInteger(value)||Number(value)<1||Number(value)>500)throw new Error('Symbol count must be1..500');continue}
      const ratios:Record<string,'normal'|'axis'|'block'|'dca'>={normalVolumeRatio:'normal',axisVolumeRatio:'axis',blockVolumeFactor:'block',dcaVolumeRatio:'dca'}
      if(ratios[key]){next.volumeRatios! [ratios[key]]=Number(value);continue}
      if(key==='volumeFactor'||key==='baseNotional'||key==='maxOrderNotional'){next[key]=Number(value);continue}
      if(key==='variantBlockEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.block.enabled=value;continue}
      if(key==='variantDcaEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.dca.enabled=value;continue}
      if(key==='axisPrevEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.axis.enabled=value;continue}
      if(key==='blockVolumeRatio'){next.coordinations.block.ratio=Number(value);continue}
      if(key==='axisPrevious'){next.coordinations.axis.previous=Number(value);continue}
      if(key==='axisLast'){next.coordinations.axis.last=Number(value);continue}
      if(key==='axisOutcome'){next.coordinations.axis.outcome=value as EngineSettings['coordinations']['axis']['outcome'];continue}
      if(key==='axisReferenceStage'){next.coordinations.axis.reference=value as 'base'|'same-stage';continue}
      if(key==='blockBehavior'){next.coordinations.block.behavior=value as 'pyramid'|'rounds';continue}
      if(key==='blockSize'){next.coordinations.block.size=Number(value);continue}
      if(key==='blockPauseRounds'){next.coordinations.block.pauseRounds=Number(value);continue}
      if(key==='blockMaxMultiplier'){next.coordinations.block.maxMultiplier=Number(value);continue}
      if(key==='blockSteps'){next.coordinations.block.steps=Number(value);continue}
      if(key==='blockMode'){next.coordinations.block.mode=value as EngineSettings['coordinations']['block']['mode'];continue}
      if(key==='dcaSteps'){next.coordinations.dca.steps=Number(value);continue}
      if(key==='dcaDistancePct'){next.coordinations.dca.distancePct=Number(value);continue}
      if(key==='dcaMultiplier'){next.coordinations.dca.multiplier=Number(value);continue}
      throw new Error(`Unknown setting ${key}`)
    }
    validateEngineSettings(next);generateStrategyCatalog(next.connectionId,next.catalog)
    // A settings change may disable entry lanes; their open positions retain immutable exits.
    this.engine.updateSettings(next)
    if(input.symbolCount!==undefined)this.control.symbolCount=Number(input.symbolCount)
    if(input.historyCandles!==undefined)this.control.historyCandles=Number(input.historyCandles)
    this.persist()
    if(this.control.running&&input.microTradeStream!==undefined)this.startTradeStream()
  }
  snapshot() {
    const s=this.engine.snapshot({laneLimit:500,positionLimit:1000,positionStage:'live'}), account=this.store.get<{equity:number;updatedAt:number}>('account')
    const stages=Object.fromEntries(s.stages.map(stage=>[stage.stage,{sets:stage.currentLanes,allSets:stage.lanes,retiredSets:stage.lanes-stage.currentLanes,eligible:stage.stage==='live'?stage.admissionReady:stage.currentQualified,enoughSamples:stage.currentEnoughSamples,samplesPercent:stage.currentLanes?100*stage.currentEnoughSamples/stage.currentLanes:null,pf:stage.closed?stage.profitFactor:null,pfState:stage.pfState,windowPF:stage.currentProfitFactor,windowPfState:stage.currentPfState,open:stage.open,closed:stage.closed,blockedByParent:stage.blockedByParent,admissionReady:stage.admissionReady,validatedWindow:stage.validatedWindow,admittedForward:stage.admittedForward,required:s.settings.stageLastN[stage.stage==='live'?'real':stage.stage]}]))
    const settings=Object.fromEntries(Object.entries(flatEngineSettings(s.settings,this.control)).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]))
    const positions=s.positions.filter(p=>p.stage==='live')
    const trades=s.liveTrades, live=s.stages.find(stage=>stage.stage==='live')!
    const warmedCount=this.control.warmed.filter(symbol=>s.settings.symbols.includes(symbol)).length
    const unrealized=(p:typeof positions[number])=>{const mark=this.marks.get(p.symbol);return mark&&Date.now()-mark.timestamp<=15_000?(mark.price-p.entryPrice)*p.quantity*(p.direction==='long'?1:-1):null}
    return {updatedAt:Date.now(),equity:account&&Date.now()-account.updatedAt<60_000?account.equity:null,paperEquity:s.equity,
      realizedPnl:live.netPnl,fees:live.fees,paperTotals:{closed:live.closed,wins:live.wins,winRate:live.closed?100*live.wins/live.closed:null,longOpen:live.longOpen,shortOpen:live.shortOpen,retainedCloses:trades.length},
      openPositions:positions.map(p=>({id:p.id,connectionId:s.settings.connectionId,symbol:p.symbol,direction:p.direction,entryPrice:p.entryPrice,quantity:p.quantity,status:'paper-open',unrealizedPnl:unrealized(p),realizedPnl:0,fee:null,createdAt:p.openedAt,closedAt:null,source:'paper'})),
      closedPositions:trades.map(p=>({id:p.id,connectionId:s.settings.connectionId,symbol:p.symbol,direction:p.direction,entryPrice:p.entryPrice,quantity:p.quantity,status:'paper-closed',unrealizedPnl:0,realizedPnl:p.netPnl,fee:p.cost,createdAt:p.openedAt,closedAt:p.closedAt,source:'paper'})),
      stages,settings,connectionId:this.connectionId,connections:CONNECTIONS.map(c=>({...c,configured:Boolean(connectionCredentials(c.id)),enabled:c.id===this.connectionId&&this.control.running,liveEnabled:c.id===this.connectionId&&this.control.exchangeExecution})),
      events:this.store.events().map(e=>({timestamp:new Date(Number(e.timestamp)||Date.now()).toISOString(),level:e.status==='rejected'?'error':'info',phase:String(e.stage||'engine'),message:`${e.type}${e.status?' '+e.status:''}: ${e.reason||String(e.laneId||'').slice(0,240)}`,connectionId:this.connectionId})),
      readiness:{x02Configured:Boolean(connectionCredentials('bingx-x02')),configured:Boolean(connectionCredentials(this.connectionId)),environment:connectionInfo(this.connectionId).environment,status:this.control.lastError||this.accountError||(this.control.running?warmedCount>=s.symbolCount?`Monitoring ${s.symbolCount} symbols`:`Market warm-up ${warmedCount}/${s.symbolCount}`:connectionCredentials(this.connectionId)?`Configured; ready to verify ${connectionInfo(this.connectionId).environment}`:`Dedicated ${connectionInfo(this.connectionId).name} credentials required`),engineStatus:this.control.running?'running':'stopped',warmedSymbols:warmedCount,lastTick:this.control.lastTick},
      positionCount:live.open,positionDisplayLimit:1000,microMarketData:{...this.tradeStream?.status,barsRecorded:this.tradeBarsRecorded,duplicates:this.tradeBars.duplicates,lateTrades:this.tradeBars.late,gaps:this.tradeBars.gaps,barSeconds:10},metricScope:'Active sets use the current configuration and gates. Lifetime PF and Live-paper totals retain all recorded cohorts and losses. Recent Live-paper closes have a separate 1,000-row history. Legacy fees remain unavailable when the old checkpoint lacks complete totals. Exchange equity and owned fills are reported separately.',
      coordinationStats:this.engine.coordinationStats(),
      engine:{processedCandles:s.processedCandles,catalogCount:s.catalogCount,symbolCount:s.symbolCount,lanes:s.lanes.slice(0,500),maxDrawdownPct:s.maxDrawdownPct,equityHistory:s.equityHistory,symbolFees:s.settings.symbolFees??{},feeReadFailures:this.control.feeReadFailures,feeCheckedAt:this.control.feeCheckedAt,feeFallbackSymbols:s.settings.symbols.filter(symbol=>!s.settings.symbolFees?.[symbol])},
      execution:{lots:this.executor.lots(),intents:this.store.intents(100),summary:this.executor.summary()},lastReplay:this.store.get('lastReplay')}
  }
}
const shared=globalThis as typeof globalThis&{__ctscRuntimes?:Map<ConnectionId,TerminalRuntime>}
export function getRuntime(connectionId:ConnectionId='bingx-x02'):TerminalRuntime{connectionInfo(connectionId);const runtimes=shared.__ctscRuntimes??=new Map<ConnectionId,TerminalRuntime>();let runtime=runtimes.get(connectionId);if(!runtime){runtime=new TerminalRuntime(connectionId);runtimes.set(connectionId,runtime)}return runtime}
export function shutdownRuntimes(){for(const runtime of shared.__ctscRuntimes?.values()??[])runtime.shutdown()}
