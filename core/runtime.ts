import { randomUUID } from 'node:crypto'
import { TradingEngine, DEFAULT_ENGINE_SETTINGS, validateEngineSettings } from './engine'
import { BingxVstClient, demoCredentials, stableClientOrderId } from './bingx'
import { planExecutionIntents } from './runtime-policy'
import { closedHistory, planHistory, validateHistory, type HistoryPlan } from './history'
import { DemoExecutor } from './executor'
import { getStore } from './store'
import type { Candle, EngineSettings, EngineEvent } from './types'
import { generateStrategyCatalog } from './catalog'

interface Control { running: boolean; exchangeExecution: boolean; warmed: string[]; symbolCount: number; historyCandles:number; lastTick: number | null; lastError: string | null }
interface Bar { bucket: number; candle: Candle; lastObservation: number }
const DEFAULT_CONTROL: Control = { running:false,exchangeExecution:false,warmed:[],symbolCount:100,historyCandles:1440,lastTick:null,lastError:null }
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
  private bars = new Map<string,Bar>()
  private warmJobs=new Map<string,{data?:Candle[];error?:string;plan?:HistoryPlan}>()
  private warmRetryAt=new Map<string,number>()
  private marks = new Map<string,{price:number;timestamp:number}>()
  private client = new BingxVstClient()
  private executor = new DemoExecutor(getStore(), this.client, {beforeSubmit:()=>this.ensureLease(),validateIntent:(intent)=>this.validateLiveIntent(intent)})
  constructor() {
    const restored = getStore().getRaw('engine')
    this.engine = restored ? TradingEngine.fromSerialized(restored) : new TradingEngine(DEFAULT_ENGINE_SETTINGS)
    this.control = { ...DEFAULT_CONTROL, ...getStore().get<Control>('control'), warmed: [] }
  }
  private validateLiveIntent(intent:import('./types').ExecutionIntent){
    if(!this.control.exchangeExecution||!this.engine.activePositionIds().has(intent.positionId))throw new Error('Entry/add signal is no longer active; no exchange order submitted')
  }
  private ensureLease() {
    if(this.leaseLost)throw new Error('Execution ownership was lost; restart this process to reload durable state')
    if(this.leased){if(getStore().renewLease(this.owner))return;this.leaseLost=true;this.control.running=false;clearTimeout(this.timer);throw new Error('Another runtime owns execution or this runtime lease expired')}
    if(!getStore().acquireLease(this.owner))throw new Error('Another CTS-C process owns this data directory')
    this.leased=true
    this.heartbeat=setInterval(()=>{try{this.ensureLease()}catch(error){this.control.lastError=error instanceof Error?error.message:'Ownership lost';clearInterval(this.heartbeat)}},5000)
    this.heartbeat.unref?.()
    const restored=getStore().getRaw('engine')
    if(restored)this.engine=TradingEngine.fromSerialized(restored)
    this.control={...this.control,...getStore().get<Control>('control'),warmed:[]}
  }
  shutdown(){clearInterval(this.heartbeat);if(this.leased&&!this.leaseLost&&getStore().ownsLease(this.owner)){this.persist();getStore().releaseLease(this.owner)}clearTimeout(this.timer);this.leased=false;this.leaseLost=true;this.control.running=false}
  serial<T>(operation:()=>Promise<T>): Promise<T> { const next=this.sequence.catch(()=>{}).then(operation); this.sequence=next; return next }
  private persist(events: EngineEvent[] = [],force=true) {
    this.ensureLease();this.bufferedEvents.push(...events)
    if(this.bufferedEvents.length>5000)this.bufferedEvents=this.bufferedEvents.slice(-5000)
    if(!force&&Date.now()-this.checkpointAt<5000&&!this.engine.pendingIntents().length)return
    getStore().saveEngineJSON(this.engine.serializeState(),this.bufferedEvents);getStore().set('control',this.control)
    this.bufferedEvents=[];this.checkpointAt=Date.now()
  }
  async start() {
    this.ensureLease()
    if(!demoCredentials())throw new Error('Dedicated x02 credentials are unavailable. Set BINGX_X02_KEY and BINGX_X02_SECRET on the server.')
    this.client = new BingxVstClient(demoCredentials()!)
    this.executor = new DemoExecutor(getStore(),this.client,{beforeSubmit:()=>this.ensureLease(),validateIntent:(intent)=>this.validateLiveIntent(intent)})
    const [balance,contracts,quotes] = await Promise.all([this.client.balance(),this.client.contracts(),this.client.quotes()])
    getStore().set('account',{...balance,updatedAt:Date.now(),source:'BingX VST'})
    const available=new Set(quotes.filter(q=>q.price>0).map(q=>q.symbol))
    const priority=['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','BCH-USDT','DOGE-USDT']
    const symbols=[...priority,...contracts.map(c=>c.symbol)].filter((s,i,a)=>a.indexOf(s)===i&&available.has(s)).slice(0,this.control.symbolCount)
    if(!symbols.length)throw new Error('No tradable VST contracts returned')
    this.ensureLease()
    const settings=this.engine.settings
    // Never lose ownership/cursors when resuming existing positions.
    const hasPositions=this.engine.hasOpenPositions()
    if(!hasPositions)this.engine.updateSettings({...settings,symbols})
    const fee=await this.client.commission(symbols[0]).catch(()=>null)
    if(fee&&!hasPositions)this.engine.updateSettings({...this.engine.settings,catalog:{...settings.catalog,makerFeePct:fee.maker*100,takerFeePct:fee.taker*100}})
    this.control={...this.control,running:true,exchangeExecution:true,lastError:null}
    this.persist()
    this.schedule()
  }
  pause() { this.ensureLease();this.control.exchangeExecution=false; this.persist() }
  stop() { this.ensureLease();this.control.running=false;this.control.exchangeExecution=false;clearTimeout(this.timer);this.timer=undefined;this.persist() }
  resume() { if(this.control.running){try{this.ensureLease();if(demoCredentials())this.schedule();else{this.control.running=false;this.control.lastError='x02 credentials unavailable after restart';this.persist()}}catch(error){this.control.running=false;this.control.lastError=error instanceof Error?error.message:'Runtime ownership unavailable'}} }
  private prefetchHistory() {
    if(!this.control.running)return
    const needed=this.engine.settings.symbols.filter(symbol=>!this.control.warmed.includes(symbol)&&!this.warmJobs.has(symbol)&&(this.warmRetryAt.get(symbol)??0)<=Date.now())
    for(const symbol of needed.slice(0,Math.max(0,3-this.warmJobs.size))){
      const job:{data?:Candle[];error?:string;plan?:HistoryPlan}={};this.warmJobs.set(symbol,job)
      try {
        const plan=job.plan=planHistory(this.control.historyCandles,this.engine.lastProcessedAt(symbol))
        if(plan.cursor===plan.cutoff)job.data=[]
        else void closedHistory(this.client,symbol,plan.count,plan.cutoff).then(data=>{job.data=data}).catch(error=>{job.error=error instanceof Error?error.message:'History unavailable'})
      } catch(error){job.error=error instanceof Error?error.message:'History unavailable'}
    }
  }
  private schedule() { if(this.timer||!this.control.running)return; this.timer=setTimeout(()=>{this.timer=undefined;void this.serial(()=>this.tick()).finally(()=>this.schedule())},1000);this.timer.unref?.() }
  private async tick() {
    if(!this.control.running)return
    try {
      this.ensureLease()
      const quotes=await this.client.quotes()
      const now=Date.now(), settings=this.engine.settings, events:EngineEvent[]=[]
      let dataGap=false
      this.ensureLease()
      for(const quote of quotes) {
        if(!this.control.warmed.includes(quote.symbol)||!settings.symbols.includes(quote.symbol))continue
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
          events.push(...this.engine.processCandles(quote.symbol,[{...previous.candle,timestamp:previous.bucket+60_000}],{allowExecution:this.control.exchangeExecution}))
          this.bars.delete(quote.symbol)
        }
        const bar=this.bars.get(quote.symbol)
        if(!bar)this.bars.set(quote.symbol,{bucket,candle:{timestamp:bucket,open:quote.price,high:quote.price,low:quote.price,close:quote.price,volume:0},lastObservation:quote.timestamp})
        else if(quote.timestamp>bar.lastObservation){bar.candle.high=Math.max(bar.candle.high,quote.price);bar.candle.low=Math.min(bar.candle.low,quote.price);bar.candle.close=quote.price;bar.lastObservation=quote.timestamp}
        events.push(...this.engine.processTick(quote.symbol,quote.price,quote.timestamp))
      }
      this.control.lastTick=now;if(!dataGap)this.control.lastError=null
      this.persist(events.splice(0),false)
      if(!this.executionTask){
        const pending=this.engine.pendingIntents().filter(i=>this.control.exchangeExecution||i.kind==='close')
        const submittedIntentIds=new Set(pending.filter(i=>getStore().intent(stableClientOrderId(i.connectionId,i.id))).map(i=>i.id))
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
      const warmed=[...this.warmJobs.entries()].filter(([,job])=>job.data||job.error).slice(0,3)
      for(const [symbol,job] of warmed){
        this.ensureLease();this.warmJobs.delete(symbol)
        try {
          if(job.error)throw new Error(job.error)
          if(job.data){
            if(job.plan){
              if(this.engine.lastProcessedAt(symbol)!==job.plan.cursor)throw new Error('History cursor changed during recovery')
              validateHistory(symbol,job.data,job.plan)
            }
            events.push(...this.engine.processCandles(symbol,job.data,{allowExecution:false}))
            if((!job.plan||job.plan.cutoff>=Math.floor(Date.now()/60_000)*60_000)&&!this.control.warmed.includes(symbol))this.control.warmed.push(symbol)
          }
        } catch(error) {this.control.lastError=`${symbol}: ${error instanceof Error?error.message:'History unavailable'}`;this.warmRetryAt.set(symbol,Date.now()+30000)}
      }
      if(warmed.length)this.persist(events.splice(0),false)
      if(now-(getStore().get<{updatedAt:number}>('account')?.updatedAt??0)>30_000){ const balance=await this.client.balance();getStore().set('account',{...balance,updatedAt:Date.now(),source:'BingX VST'}) }
    } catch(error) {this.control.lastError=error instanceof Error?error.message:'Exchange processing unavailable';if(this.leased&&!this.leaseLost&&getStore().ownsLease(this.owner))getStore().set('control',this.control)}
  }
  saveFlatSettings(input:Record<string,unknown>) {
    this.ensureLease()
    const current=this.engine.settings, next=structuredClone(current)
    const catalogKeys=['strategyEnabledRanges','strategyTpSteps','strategySlRatios','strategyExitModes','strategyIndicationTypes','makerFeePct','takerFeePct','slippagePctOfFees']
    const gateMap:Record<string,['stageLastN'|'stageMinPF','base'|'main'|'real']>={prevPosWindow:['stageLastN','base'],mainEvalPosCount:['stageLastN','main'],realEvalPosCount:['stageLastN','real'],baseProfitFactor:['stageMinPF','base'],mainProfitFactor:['stageMinPF','main'],realProfitFactor:['stageMinPF','real']}
    for(const [key,value] of Object.entries(input)) {
      if(catalogKeys.includes(key)){next.catalog[key]=value;continue}
      if(gateMap[key]){const[group,stage]=gateMap[key];next[group][stage]=Number(value);continue}
      if(key==='historyCandles'){if(!Number.isInteger(value)||Number(value)<100||Number(value)>1440)throw new Error('History candles must be 100..1440');continue}
      if(key==='symbolCount'){if(!Number.isInteger(value)||Number(value)<1||Number(value)>500)throw new Error('Symbol count must be1..500');continue}
      if(key==='volumeFactor'||key==='baseNotional'){next[key]=Number(value);continue}
      if(key==='variantBlockEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.block.enabled=value;continue}
      if(key==='variantDcaEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.dca.enabled=value;continue}
      if(key==='axisPrevEnabled'){if(typeof value!=='boolean')throw new Error('Boolean required');next.coordinations.axis.enabled=value;continue}
      if(key==='blockVolumeRatio'){next.coordinations.block.ratio=Number(value);continue}
      if(key==='axisPrevious'){next.coordinations.axis.previous=Number(value);continue}
      if(key==='axisLast'){next.coordinations.axis.last=Number(value);continue}
      if(key==='axisOutcome'){next.coordinations.axis.outcome=value as EngineSettings['coordinations']['axis']['outcome'];continue}
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
    const s=this.engine.snapshot({laneLimit:500,positionLimit:1000,positionStage:'live'}), account=getStore().get<{equity:number;updatedAt:number}>('account')
    const stages=Object.fromEntries(s.stages.map(stage=>[stage.stage,{sets:stage.lanes,eligible:stage.qualified,enoughSamples:stage.enoughSamples,samplesPercent:stage.lanes?stage.enoughSamplesPct:null,pf:stage.closed?stage.profitFactor:null,pfState:stage.pfState}]))
    const settings:Record<string,string>={...Object.fromEntries(Object.entries(s.settings.catalog).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])),symbolCount:String(this.control.symbolCount),historyCandles:String(this.control.historyCandles),volumeFactor:String(s.settings.volumeFactor),baseNotional:String(s.settings.baseNotional),prevPosWindow:String(s.settings.stageLastN.base),prevPosMinCount:String(s.settings.stageLastN.base),mainEvalPosCount:String(s.settings.stageLastN.main),realEvalPosCount:String(s.settings.stageLastN.real),baseProfitFactor:String(s.settings.stageMinPF.base),mainProfitFactor:String(s.settings.stageMinPF.main),realProfitFactor:String(s.settings.stageMinPF.real),liveProfitFactor:String(s.settings.stageMinPF.real),variantBlockEnabled:String(s.settings.coordinations.block.enabled),variantDcaEnabled:String(s.settings.coordinations.dca.enabled),axisPrevEnabled:String(s.settings.coordinations.axis.enabled),axisLastEnabled:String(s.settings.coordinations.axis.enabled),axisContEnabled:String(s.settings.coordinations.axis.enabled),axisPauseEnabled:'false',variantTrailingEnabled:'true',variantPauseEnabled:'false',blockVolumeRatio:String(s.settings.coordinations.block.ratio),axisPrevious:String(s.settings.coordinations.axis.previous),axisLast:String(s.settings.coordinations.axis.last),axisOutcome:s.settings.coordinations.axis.outcome,blockSteps:String(s.settings.coordinations.block.steps),blockMode:s.settings.coordinations.block.mode,dcaSteps:String(s.settings.coordinations.dca.steps),dcaDistancePct:String(s.settings.coordinations.dca.distancePct),dcaMultiplier:String(s.settings.coordinations.dca.multiplier)}
    const positions=s.positions.filter(p=>p.stage==='live')
    const trades=s.trades.filter(t=>t.stage==='live')
    const unrealized=(p:typeof positions[number])=>{const mark=this.marks.get(p.symbol);return mark&&Date.now()-mark.timestamp<=15_000?(mark.price-p.entryPrice)*p.quantity*(p.direction==='long'?1:-1):null}
    return {updatedAt:Date.now(),equity:account&&Date.now()-account.updatedAt<60_000?account.equity:null,paperEquity:s.equity,
      realizedPnl:trades.reduce((sum,t)=>sum+t.netPnl,0),fees:trades.reduce((sum,t)=>sum+t.cost,0),
      openPositions:positions.map(p=>({id:p.id,connectionId:s.settings.connectionId,symbol:p.symbol,direction:p.direction,entryPrice:p.entryPrice,quantity:p.quantity,status:'paper-open',unrealizedPnl:unrealized(p),realizedPnl:0,fee:null,createdAt:p.openedAt,closedAt:null,source:'paper'})),
      closedPositions:trades.map(p=>({id:p.id,connectionId:s.settings.connectionId,symbol:p.symbol,direction:p.direction,entryPrice:p.entryPrice,quantity:p.quantity,status:'paper-closed',unrealizedPnl:0,realizedPnl:p.netPnl,fee:p.cost,createdAt:p.openedAt,closedAt:p.closedAt,source:'paper'})),
      stages,settings,connections:[{id:'bingx-x02',name:'X02',exchange:'bingx',demo:true,configured:Boolean(demoCredentials()),enabled:this.control.running,liveEnabled:this.control.exchangeExecution}],
      events:getStore().events().map(e=>({timestamp:new Date(Number(e.timestamp)||Date.now()).toISOString(),level:e.status==='rejected'?'error':'info',phase:String(e.stage||'engine'),message:`${e.type}${e.status?' '+e.status:''}: ${e.reason||String(e.laneId||'').slice(0,240)}`,connectionId:'bingx-x02'})),
      readiness:{x02Configured:Boolean(demoCredentials()),status:this.control.lastError||(this.control.running?this.control.warmed.length>=s.symbolCount?`Monitoring ${s.symbolCount} symbols`:`Market warm-up ${this.control.warmed.length}/${s.symbolCount}`:demoCredentials()?'Configured; ready to verify VST':'Dedicated x02 credentials required'),engineStatus:this.control.running?'running':'stopped',warmedSymbols:this.control.warmed.length,lastTick:this.control.lastTick},
      positionCount:s.stages.find(stage=>stage.stage==='live')?.open??0,positionDisplayLimit:1000,metricScope:'Lane counts are paper forward evaluations. PnL/fees cover Live-stage trades within the latest 1,000 closes across all stages; they are estimates including slippage. Account equity is separately read from BingX VST. No simulated value is presented as exchange equity.',
      engine:{processedCandles:s.processedCandles,catalogCount:s.catalogCount,symbolCount:s.symbolCount,lanes:s.lanes.slice(0,500),maxDrawdownPct:s.maxDrawdownPct,equityHistory:s.equityHistory},
      execution:{lots:this.executor.lots(),intents:getStore().intents(100),summary:this.executor.summary()},lastReplay:getStore().get('lastReplay')}
  }
}
const shared=globalThis as typeof globalThis&{__ctscRuntime?:TerminalRuntime}
export function getRuntime(){return shared.__ctscRuntime??=new TerminalRuntime()}
