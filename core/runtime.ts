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
const DEFAULT_CONTROL: Control = { running:false,exchangeExecution:false,warmed:[],symbolCount:100,historyCandles:1440,lastTick:null,lastError:null,feeReadFailures:[],feeCheckedAt:null }
function retainEvents(target:EngineEvent[],source:readonly EngineEvent[],limit=5000){
  if(source.length>=limit)target.length=0
  for(let i=Math.max(0,source.length-limit);i<source.length;i++)target.push(source[i])
  if(target.length>limit)target.splice(0,target.length-limit)
}
export class TerminalRuntime {
  engine: TradingEngine
  control: Control
  private timer?: ReturnType<typeof setTimeout>
  private readonly owner=randomUUID()
  private leased=false
  private leaseLost=false
  private heartbeat?:ReturnType<typeof setInterval>
  private checkpointAt=0
  private bufferedEvents:EngineEvent[]=[]
  private sequence: Promise<unknown> = Promise.resolve()
  private executionTask?:Promise<void>
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
    this.engine = restored ? TradingEngine.fromOwnedCheckpoint(restored) : new TradingEngine({...DEFAULT_ENGINE_SETTINGS,connectionId})
    if(this.engine.settings.connectionId!==connectionId)throw new Error('Engine checkpoint belongs to another connection')
    this.control = { ...DEFAULT_CONTROL, ...this.store.get<Control>('control'), warmed: [] }
  }
  private validateLiveIntent(intent:import('./types').ExecutionIntent){
    if(!this.control.exchangeExecution||!this.engine.isLiveIntentEligible(intent.positionId))throw new Error('Entry/add signal is no longer active or its qualification changed; no exchange order submitted')
  }
  private ensureLease() {
    if(this.leaseLost)throw new Error('Execution ownership was lost; restart this process to reload durable state')
    if(this.leased){if(this.store.renewLease(this.owner))return;this.leaseLost=true;this.control.running=false;clearTimeout(this.timer);throw new Error('Another runtime owns execution or this runtime lease expired')}
    if(!this.store.acquireLease(this.owner))throw new Error('Another CTS-C process owns this data directory')
    this.leased=true
    this.heartbeat=setInterval(()=>{try{this.ensureLease()}catch(error){this.control.lastError=error instanceof Error?error.message:'Ownership lost';clearInterval(this.heartbeat)}},5000)
    this.heartbeat.unref?.()
    const restored=this.store.loadEngineState()
    if(restored)this.engine=TradingEngine.fromOwnedCheckpoint(restored)
    this.control={...this.control,...this.store.get<Control>('control'),warmed:[]}
  }
  shutdown(){clearInterval(this.heartbeat);if(this.leased&&!this.leaseLost&&this.store.ownsLease(this.owner)){this.persist();this.store.releaseLease(this.owner)}clearTimeout(this.timer);this.leased=false;this.leaseLost=true;this.control.running=false}
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
    this.schedule()
  }
  pause() { this.ensureLease();this.control.exchangeExecution=false; this.persist() }
  stop() { this.ensureLease();this.control.running=false;this.control.exchangeExecution=false;clearTimeout(this.timer);this.timer=undefined;this.persist() }
  resume() { if(this.control.running){try{this.ensureLease();if(connectionCredentials(this.connectionId))this.schedule();else{this.control.running=false;this.control.lastError=`${connectionInfo(this.connectionId).name} credentials unavailable after restart`;this.persist()}}catch(error){this.control.running=false;this.control.lastError=error instanceof Error?error.message:'Runtime ownership unavailable'}} }
  private prefetchHistory() {
    if(!this.control.running)return
    const latest=Math.floor(Date.now()/60000)*60000
    const needed=this.engine.managedSymbols().filter(symbol=>(!this.control.warmed.includes(symbol)||(this.engine.lastProcessedAt(symbol)??latest)<latest)&&!this.warmJobs.has(symbol)&&(this.warmRetryAt.get(symbol)??0)<=Date.now())
    for(const symbol of needed.slice(0,Math.max(0,3-this.warmJobs.size))){
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
  private consumeHistory(events:EngineEvent[],coldOnly=false){
      const warmed=[...this.warmJobs.entries()].filter(([,job])=>(job.data||job.error)&&(!coldOnly||!job.live)).slice(0,3)
      for(const [symbol,job] of warmed){
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
            const began=performance.now(),offset=job.offset??0
            while((job.offset??0)<job.data.length&&(job.offset??0)-offset<128&&performance.now()-began<200){
              const chunk=job.data.slice(job.offset,(job.offset??0)+8)
              const fresh=job.live===true&&job.data.length===1&&job.plan?.cutoff===Math.floor(Date.now()/60000)*60000
              retainEvents(events,this.engine.processCandles(symbol,chunk,{allowExecution:fresh&&this.control.exchangeExecution,eventLimit:5000}))
              job.offset=(job.offset??0)+chunk.length;job.cursor=this.engine.lastProcessedAt(symbol)
            }
            if((job.offset??0)>=job.data.length){
              this.warmJobs.delete(symbol)
              if((!job.plan||job.plan.cutoff>=Math.floor(Date.now()/60_000)*60_000)&&!this.control.warmed.includes(symbol))this.control.warmed.push(symbol)
            }
          }
        } catch(error) {this.warmJobs.delete(symbol);this.control.lastError=`${symbol}: ${error instanceof Error?error.message:'History unavailable'}`;this.warmRetryAt.set(symbol,Date.now()+30000)}
      }
      if(warmed.length)this.persist(events.splice(0),false)
  }
  private schedule() { if(this.timer||!this.control.running)return; this.timer=setTimeout(()=>{this.timer=undefined;void this.serial(()=>this.tick()).finally(()=>this.schedule())},1000);this.timer.unref?.() }
  private async tick() {
    if(!this.control.running)return
    try {
      this.ensureLease()
      const events:EngineEvent[]=[]
      this.prefetchHistory()
      let quoteReady=false
      const quoteRead=this.client.quotes()
      void quoteRead.then(()=>{quoteReady=true},()=>{quoteReady=true})
      await Promise.resolve()
      while(!quoteReady&&this.control.running){
        const cold=[...this.warmJobs.values()].some(job=>!job.live)
        if(!cold)break
        this.consumeHistory(events,true)
        this.prefetchHistory()
        await new Promise<void>(resolve=>setTimeout(resolve,25))
      }
      const quotes=await quoteRead
      const now=Date.now(), settings=this.engine.settings
      const managed=new Set(this.engine.managedSymbols())
      let dataGap=false
      this.ensureLease()
      for(const quote of quotes) {
        if(!this.control.warmed.includes(quote.symbol)||!managed.has(quote.symbol))continue
        if(!Number.isFinite(quote.price)||quote.price<=0||Date.now()-quote.timestamp>15_000||quote.timestamp>Date.now()+5000)continue
        this.marks.set(quote.symbol,{price:quote.price,timestamp:quote.timestamp})
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
      this.control.lastTick=now;if(!dataGap)this.control.lastError=null
      this.persist(events.splice(0),false)
      if(!this.executionTask){
        const pending=this.engine.pendingIntents().filter(i=>this.control.exchangeExecution||i.kind==='close')
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
    const catalogKeys=['strategyEnabledRanges','strategyTpSteps','strategySlRatios','strategyExitModes','strategyIndicationTypes','strategySignalPeriods','strategySignalTimeframes','strategyTpFactor','strategySlFactor','strategyTrailRatio','holdTimeFactor','makerFeePct','takerFeePct','slippagePctOfFees']
    const gateMap:Record<string,['stageLastN'|'stageMinPF','base'|'main'|'real']>={prevPosWindow:['stageLastN','base'],mainEvalPosCount:['stageLastN','main'],realEvalPosCount:['stageLastN','real'],baseProfitFactor:['stageMinPF','base'],mainProfitFactor:['stageMinPF','main'],realProfitFactor:['stageMinPF','real']}
    for(const [key,value] of Object.entries(input)) {
      if(key==='stageGateMode'){next.stageGateMode=value as EngineSettings['stageGateMode'];continue}
      if(catalogKeys.includes(key)){next.catalog[key]=value;continue}
      if(gateMap[key]){const[group,stage]=gateMap[key];next[group][stage]=Number(value);continue}
      if(key==='historyCandles'){if(!Number.isInteger(value)||Number(value)<100||Number(value)>1440)throw new Error('History candles must be 100..1440');continue}
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
      positionCount:live.open,positionDisplayLimit:1000,metricScope:'Active sets use the current configuration and gates. Lifetime PF and Live-paper totals retain all recorded cohorts and losses. Recent Live-paper closes have a separate 1,000-row history. Legacy fees remain unavailable when the old checkpoint lacks complete totals. Exchange equity and owned fills are reported separately.',
      coordinationStats:this.engine.coordinationStats(),
      engine:{processedCandles:s.processedCandles,catalogCount:s.catalogCount,symbolCount:s.symbolCount,lanes:s.lanes.slice(0,500),maxDrawdownPct:s.maxDrawdownPct,equityHistory:s.equityHistory,symbolFees:s.settings.symbolFees??{},feeReadFailures:this.control.feeReadFailures,feeCheckedAt:this.control.feeCheckedAt,feeFallbackSymbols:s.settings.symbols.filter(symbol=>!s.settings.symbolFees?.[symbol])},
      execution:{lots:this.executor.lots(),intents:this.store.intents(100),summary:this.executor.summary()},lastReplay:this.store.get('lastReplay')}
  }
}
const shared=globalThis as typeof globalThis&{__ctscRuntimes?:Map<ConnectionId,TerminalRuntime>}
export function getRuntime(connectionId:ConnectionId='bingx-x02'):TerminalRuntime{connectionInfo(connectionId);const runtimes=shared.__ctscRuntimes??=new Map<ConnectionId,TerminalRuntime>();let runtime=runtimes.get(connectionId);if(!runtime){runtime=new TerminalRuntime(connectionId);runtimes.set(connectionId,runtime)}return runtime}
export function shutdownRuntimes(){for(const runtime of shared.__ctscRuntimes?.values()??[])runtime.shutdown()}
