import {blockPrefix,blockRequired,blockPolicyKey,checkBlockPolicy,evaluateBlocks,type BlockPolicy} from "../shared/cts-lastn/blocks.ts";
import {blockRoundBudget,settleBlockRound,consumeBlockPause} from "./block-rounds"
import { checkBlockPyramidAdd, settleBlockSteps } from "./block-auto"
import { validateStepAuto } from "./step-evidence"
import { dcaStepVerdict, observeDcaStep, settleDcaSteps, validateDcaAuto } from "./dca-auto"
import {normalizedVolumeFactor,relationalVolumeSettings} from "../shared/cts-volume/ratios";
import { strategyProcessing } from "./strategy-processing"
import { createHash } from "node:crypto"
import { generateStrategyCatalog } from "./catalog"
import { advanceConfiguredSignal, advancePortedSources, historicalPortedSignals, newSignalState } from "./replay"
import { describeProfitFactor, POSITION_COST_PCT_DEFAULT } from "./metrics"
import { observedExit } from "./exits"
import { ConfigStageWindows, type WindowEvidence } from "./config-stage-windows"
import type { Candle, ClosedTrade, Coordination, Direction, EngineEvent, EngineSettings, EngineSnapshot, EngineState, ExecutionIntent, LaneState, PaperPosition, Stage, StageWindowScope, StrategyConfig,GateProof } from "./types"

export const STAGES: Stage[] = ["base", "main", "real", "live"]
const STAGE_INDEX:Record<Stage,number>={base:0,main:1,real:2,live:3}
const COORDINATION_OFFSET:Record<Coordination,number>={normal:0,axis:4,block:8,dca:12}
type LaneContext={long:(LaneState|undefined)[];short:(LaneState|undefined)[]}
type ConfigStream={config:StrategyConfig;key:string}
const OWN_PARSED_STATE = Symbol("engine-owned JSON state")
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  connectionId: "bingx-x02", symbols: ["BTC-USDT", "ETH-USDT", "SOL-USDT"], initialEquity: 10_000,
  baseNotional: 100, volumeFactor: .01, stageLastN: { base: 20, main: 8, real: 8 },
  volumeRatios:{normal:1,axis:1,block:1,dca:1},maxOrderNotional:0,
  stageGateMode:'continuous-ancestors',
  stageWindowScope:"context", microStageWindowScope:"inherit",
  liveEntryMode:'independent',
  stageMinPF: { base: 1.1, main: 1.1, real: 1.1 }, maxSamples: 250,
  catalog: { strategyTpSteps: [3, 5, 8, 12, 18, 24, 30], strategySlRatios: [.6, 1, 1.4] },
  coordinations: { axis: { enabled: true, previous: 8, last: 3, outcome: "any",reference:'same-stage' },
    block: { enabled: true, steps: 3, ratio: .2, mode: "shared" },
    dca: { enabled: true, steps: 2, distancePct: 1, multiplier: 2 } },
}
export function normalizeSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase().replace("/", "-").replace("_", "-")
  return /^[A-Z0-9]+USDT$/.test(value) ? `${value.slice(0, -4)}-USDT` : value
}
const finite = (value: number, name: string, min: number, max: number, integer = false) => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}`)
}
export function validateEngineSettings(input: Partial<EngineSettings> = {}): EngineSettings {
  const d = DEFAULT_ENGINE_SETTINGS
  const settings: EngineSettings = {
    ...structuredClone(d), ...input, symbols: (input.symbols ?? d.symbols).map(normalizeSymbol),
    volumeRatios:{...d.volumeRatios!,...input.volumeRatios},
    symbolFees:structuredClone(input.symbolFees??{}),
    catalog: input.catalog === undefined ? structuredClone(d.catalog) : structuredClone(input.catalog), stageLastN: { ...d.stageLastN, ...input.stageLastN }, stageMinPF: { ...d.stageMinPF, ...input.stageMinPF },
    coordinations: { axis: { ...d.coordinations.axis, ...input.coordinations?.axis }, block: { ...d.coordinations.block, ...input.coordinations?.block }, dca: { ...d.coordinations.dca, ...input.coordinations?.dca } },
  }
  if (!settings.connectionId || settings.symbols.length < 1 || settings.symbols.length > 500 || settings.symbols.some(s => !/^[A-Z0-9]{1,30}-USDT$/.test(s))) throw new Error("Invalid connection or symbols")
  if(!['continuous-ancestors','processed-sets'].includes(settings.stageGateMode??''))throw new Error('Invalid stage gate mode')
  settings.stageWindowScope??="context";settings.microStageWindowScope??="inherit"
  if(!["context","config","both"].includes(settings.stageWindowScope)||!["inherit","context","config","both"].includes(settings.microStageWindowScope))throw new Error("Invalid stage window scope")
  if(!['independent','real-mirror'].includes(settings.liveEntryMode??''))throw new Error('Invalid Live entry mode')
  settings.symbols = [...new Set(settings.symbols)]
  finite(settings.initialEquity, "initialEquity", .01, 1e12); finite(settings.baseNotional, "baseNotional", .000001, 1e9)
  finite(settings.volumeFactor, "volumeFactor", .000001, 100); finite(settings.maxSamples, "maxSamples", 1, 1000, true)
  for(const coordination of ['normal','axis','block','dca'] as const)finite(settings.volumeRatios![coordination],`${coordination} volume ratio`,.001,100)
  finite(settings.maxOrderNotional??0,'maximum order notional',0,1e9)
  for (const stage of ["base", "main", "real"] as const) { finite(settings.stageLastN[stage], `${stage} lastN`, 1, settings.maxSamples, true); finite(settings.stageMinPF[stage], `${stage} PF`, 0, 999) }
  if(settings.stageBlocks)for(const [stage,policy]of Object.entries(settings.stageBlocks)){
    if(!["base","main","real"].includes(stage))throw new Error("Invalid block stage");checkBlockPolicy(policy);
    if(blockRequired(policy)>settings.maxSamples)throw new Error("Disjoint blocks exceed retained samples");
    if(settings.stageMinPF[stage as "base"|"main"|"real"]<=1)throw new Error("Disjoint block PF must exceed one");
  }
  const { axis, block, dca } = settings.coordinations
  finite(axis.previous, "axis previous", 1, settings.maxSamples, true); finite(axis.last, "axis last", 1, settings.maxSamples, true)
  if (axis.enabled && axis.previous + axis.last > settings.maxSamples) throw new Error("Axis windows exceed retained samples")
  if (!["positive", "negative", "any"].includes(axis.outcome)) throw new Error("Invalid axis outcome")
  if(axis.reference!==undefined&&!['base','same-stage'].includes(axis.reference))throw new Error('Invalid Axis reference stage')
  if(block.behavior!==undefined&&!['pyramid','rounds'].includes(block.behavior))throw new Error('Invalid Block behavior')
  finite(block.size??3,'block size',1,100,true);finite(block.pauseRounds??1,'block pause rounds',0,100,true);finite(block.maxMultiplier??3,'block multiplier cap',1,10)
  finite(block.steps, "block steps", 1, 20, true); finite(block.ratio, "block ratio", .01, 10)
  if (!["shared", "additive"].includes(block.mode)) throw new Error("Invalid block mode")
  if (block.auto !== undefined) block.auto = validateStepAuto(block.auto, "Block")
  finite(dca.steps, "DCA steps", 1, 20, true); finite(dca.distancePct, "DCA distance", .001, 100); finite(dca.multiplier, "DCA multiplier", .01, 10)
  if (dca.auto !== undefined) dca.auto = validateDcaAuto(dca.auto)
  for (const enabled of [axis.enabled, block.enabled, dca.enabled]) if (typeof enabled !== "boolean") throw new Error("Coordination enabled must be boolean")
  generateStrategyCatalog(settings.connectionId, settings.catalog)
  const checkedFees=new Set<string>()
  for(const [symbol,fees] of Object.entries(settings.symbolFees??{})){
    if(!/^[A-Z0-9]{1,30}-USDT$/.test(symbol))throw new Error('Invalid fee symbol')
    finite(fees.makerFeePct,'symbol maker fee',0,20);finite(fees.takerFeePct,'symbol taker fee',0,20)
    const identity=JSON.stringify(fees)
    if(!checkedFees.has(identity)){generateStrategyCatalog(settings.connectionId,{...settings.catalog,...fees});checkedFees.add(identity)}
  }
  return settings
}
function laneKey(connectionId: string, symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage, identity: string): string {
  // JSON identities cannot collide when a user changes delimiters in a label.
  return JSON.stringify([connectionId, symbol, config.id, direction, coordination, stage, identity])
}
type WindowResult={pfSampleCount?:number;blockPolicyKey?:string;drawdownPct?:number;maxDrawdownPct?:number;count:number;required:number;minPF:number;profit:number|null;loss:number|null;enoughSamples:boolean;profitFactor:number|null;pfState:import('./types').ProfitFactorState;qualified:boolean}
type StageWindowResult=WindowResult&Pick<GateProof,"windowScope"|"configWindow">&{windowKey?:string}
const windowCache=new WeakMap<WindowEvidence,{closed:number;samples:number[];length:number;head:number|undefined;value:WindowResult}>()
const blockWindowCache=new WeakMap<WindowEvidence,{closed:number;samples:number[];head:number|undefined;length:number;key:string;value:WindowResult}>()
const axisCache=new WeakMap<WindowEvidence,{closed:number;samples:number[];length:number;head:number|undefined;previous:number;last:number;outcome:string;threshold:number;allowed:boolean}>()
function knownWindow(samples:readonly unknown[],count:number):boolean {
  for(let i=0;i<count;i++)if(typeof samples[i]!=='number'||!Number.isFinite(samples[i]))return false
  return true
}
export function windowMetrics(lane: WindowEvidence | undefined, required: number, minPF: number, blocks?:BlockPolicy):WindowResult {
  const cap=lane?.config.maxWindowDrawdownPct
  if(blocks){
    minPF=Math.max(minPF,lane?.config.autoPfFloor??0);
    const samples=lane?.samples??[],key=blockPolicyKey(blocks),cached=lane?blockWindowCache.get(lane):undefined;
    if(cached&&cached.closed===lane!.closedCount&&cached.samples===samples&&cached.length===samples.length&&cached.head===samples[0]&&cached.key===key&&cached.value.minPF===minPF&&cached.value.maxDrawdownPct===cap)return cached.value;
    const result=evaluateBlocks(blockPrefix(samples,blockRequired(blocks)),blocks,minPF);
    const unknown=result.state==='unknown';
    const pf=unknown?{profitFactor:null,pfState:'unknown' as const}:describeProfitFactor(result.long.gp,result.long.gl,result.long.count);
    const drawdown:{drawdownPct?:number;maxDrawdownPct:number}|undefined=cap===undefined?undefined:unknown?{maxDrawdownPct:cap}:windowRisk(samples,result.required,cap)
    const value={profit:unknown?null:result.long.gp,loss:unknown?null:result.long.gl,pfSampleCount:result.long.count,count:result.count,required:result.required,minPF,enoughSamples:!unknown&&result.count===result.required,...pf,...drawdown,qualified:result.state==="qualified"&&(cap===undefined||drawdown?.drawdownPct!==undefined&&drawdown.drawdownPct<=cap),blockPolicyKey:result.key};
    if(lane)blockWindowCache.set(lane,{closed:lane.closedCount,samples,head:samples[0],length:samples.length,key,value});
    return value;
  }
  minPF = Math.max(minPF,lane?.config.autoPfFloor??0)
  const samples = lane?.samples ?? [], count = Math.min(samples.length, required)
  const cached=lane?windowCache.get(lane):undefined
  if(cached&&cached.closed===lane!.closedCount&&cached.samples===samples&&cached.length===samples.length&&cached.head===samples[0]&&cached.value.required===required&&cached.value.minPF===minPF&&cached.value.maxDrawdownPct===cap)return cached.value
  const unknown=()=>{
    const value:WindowResult={count,required,minPF,profit:null,loss:null,enoughSamples:false,profitFactor:null,pfState:'unknown',qualified:false,...(cap===undefined?{}:{maxDrawdownPct:cap})}
    if(lane)windowCache.set(lane,{closed:lane.closedCount,samples,length:samples.length,head:samples[0],value})
    return value
  }
  if(!knownWindow(samples,count))return unknown()
  let profit = 0, loss = 0
  for (let i = 0; i < count; i++) { profit += Math.max(0, samples[i]); loss += Math.max(0, -samples[i]) }
  if(!Number.isFinite(profit)||!Number.isFinite(loss))return unknown()
  const pf = describeProfitFactor(profit, loss, count)
  const drawdown=cap===undefined?undefined:windowRisk(samples,count,cap)
  const value={count,required,minPF,profit,loss,enoughSamples:count>=required,...pf,...drawdown,qualified:count>=required&&pf.profitFactor>=minPF&&(cap===undefined||drawdown!.drawdownPct<=cap)}
  if(lane)windowCache.set(lane,{closed:lane.closedCount,samples,length:samples.length,head:samples[0],value})
  return value
}
function windowRisk(samples:readonly number[],count:number,cap:number){
 let sum=0,peak=0,drawdownPct=0
 for(let i=Math.min(count,samples.length)-1;i>=0;i--){sum+=samples[i];peak=Math.max(peak,sum);drawdownPct=Math.max(drawdownPct,peak-sum)}
 return {drawdownPct,maxDrawdownPct:cap}
}
export function validateObservedCandles(candles:readonly Candle[]):void{
  let previous=-Infinity
  for(const candle of candles){
    if(![candle.timestamp,candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite)
      ||candle.timestamp<=0||candle.close<=0||candle.open<=0||candle.low<=0||candle.high<Math.max(candle.open,candle.close,candle.low)
      ||candle.low>Math.min(candle.open,candle.close)||candle.volume<0||candle.timestamp<=previous)throw new Error('Invalid or unsorted observed candles')
    previous=candle.timestamp
  }
}
export class TradingEngine {
  private liveCloseObserver?:(trade:ClosedTrade)=>void
  observeLiveCloses(observer:(trade:ClosedTrade)=>void){this.liveCloseObserver=observer}
  private state: EngineState
  private configs: StrategyConfig[]
  private symbolConfigs=new Map<string,StrategyConfig[]>()
  private symbolConfigIds=new Map<string,Set<string>>()
  private streams=new Map<string,ConfigStream[]>()
  private signalStreams=new Map<string,ConfigStream[]>()
  private portedStreams=new Map<string,{minutes:number;stateKey:string;ids:string[];streams:ConfigStream[];usesReferences:boolean}[]>()
  private microStreams=new Map<string,ConfigStream[]>()
  private minuteStreams=new Map<string,ConfigStream[]>()
  private coordinationIds = {} as Record<Coordination, string>
  private processedCoordinationIds={} as Record<Coordination,string>
  private active = new Map<string, Set<string>>()
  private activeMicro = new Map<string, Set<string>>()
  private activeMinute = new Map<string, Set<string>>()
  private livePositions = new Map<string,LaneState>()
  private configIds = new Set<string>()
  private currentLaneIds = new Set<string>()
  private contexts=new Map<string,Map<string,LaneContext>>()
  private configWindows=new ConfigStageWindows()
  private validLineages=new Set<string>()
  private dirtyLaneIds=new Set<string>()
  private volumeWeights=relationalVolumeSettings(undefined)
  private readonly maxRecentTrades = 1000
  /** Parse an independently owned checkpoint without duplicating its entire ledger. */
  static fromSerialized(serialized: string): TradingEngine {
    const restored = JSON.parse(serialized) as EngineState
    if (!restored || typeof restored !== "object") throw new Error("Invalid engine state")
    return new TradingEngine(restored.settings, restored, OWN_PARSED_STATE)
  }
  /** Store loaders construct a fresh, exclusively owned state without a second whole-ledger clone. */
  static fromOwnedCheckpoint(restored:EngineState):TradingEngine{return new TradingEngine(restored.settings,restored,OWN_PARSED_STATE)}
  checkpointMetadata():string{const {lanes,...metadata}=this.state;return JSON.stringify(metadata)}
  *checkpointLanes(all=false):Generator<{id:string;data:string}>{
    if(all){for(const id in this.state.lanes)yield {id,data:JSON.stringify(this.state.lanes[id])}}
    else for(const id of this.dirtyLaneIds)yield {id,data:JSON.stringify(this.state.lanes[id])}
  }
  checkpointSaved():void{this.dirtyLaneIds.clear()}
  constructor(settings: Partial<EngineSettings> = {}, restored?: EngineState, ownership?: symbol) {
    const validated = validateEngineSettings({ ...restored?.settings, ...settings })
    if (restored && restored.version !== 1) throw new Error("Unsupported engine state")
    if (restored && restored.settings.connectionId !== validated.connectionId) throw new Error("Restored engine belongs to another connection")
    this.state = restored ? ownership === OWN_PARSED_STATE ? restored : structuredClone(restored) : {
      version: 1, settings: validated, lanes: {}, signals: {}, lastTimestamp: {}, recentTrades: [], intents: [], processedCandles: 0,
      startedAt: Date.now(), updatedAt: 0, equity: validated.initialEquity, peakEquity: validated.initialEquity, maxDrawdownPct: 0, equityHistory: [],
    }
    this.state.settings = validated
    this.configs = generateStrategyCatalog(validated.connectionId, validated.catalog, "1970-01-01T00:00:00.000Z")
    this.refreshSymbolCatalogs()
    this.state.recentLiveTrades??=this.state.recentTrades.filter(trade=>trade.stage==="live")
    this.refreshCoordinationIds()
    this.refreshCurrentLaneIds()
    this.state.nextActivationOrder??=0
    const openLanes:LaneState[]=[],orders=new Set<number>()
    for (const lane of Object.values(this.state.lanes)) {
      if ((lane.sampleTimes?.length ?? 0) < lane.samples.length && lane.untimedSamplesThrough === undefined) {
        lane.untimedSamplesThrough = lane.sampleTimes?.at(-1) ?? lane.open?.openedAt ?? lane.lastTimestamp
        this.dirtyLaneIds.add(lane.id)
      }
      this.trimSamples(lane)
      if(lane.open){
        const order=lane.open.activationOrder
        if(order!==undefined){if(!Number.isSafeInteger(order)||order<1||orders.has(order))throw new Error('Invalid active position order');orders.add(order);this.state.nextActivationOrder=Math.max(this.state.nextActivationOrder,order)}
        openLanes.push(lane)
      }
    }
    for(const lane of openLanes)if(lane.open!.activationOrder===undefined){lane.open!.activationOrder=++this.state.nextActivationOrder;this.dirtyLaneIds.add(lane.id)}
    openLanes.sort((a,b)=>a.open!.activationOrder!-b.open!.activationOrder!)
    for(const lane of openLanes)this.activate(lane)
  }
  get settings(): EngineSettings { return structuredClone(this.state.settings) }
  managedSymbols():string[]{return [...new Set([...this.state.settings.symbols,...[...this.active].filter(([,lanes])=>lanes.size>0).map(([symbol])=>symbol)])]}
  lastProcessedAt(symbol: string,barSeconds:10|60=60): number | null { return (barSeconds===10?this.state.lastMicroTimestamp:this.state.lastTimestamp)?.[normalizeSymbol(symbol)] ?? null }
  updateSettings(input: Partial<EngineSettings>): void {
    const previous = this.state.settings
    if (input.connectionId && input.connectionId !== previous.connectionId) throw new Error("Use a separate engine for another connection")
    this.state.settings = validateEngineSettings({ ...previous, ...input,
      volumeRatios:{...previous.volumeRatios!,...input.volumeRatios},
      stageLastN: { ...previous.stageLastN, ...input.stageLastN }, stageMinPF: { ...previous.stageMinPF, ...input.stageMinPF },
      coordinations: { axis: { ...previous.coordinations.axis, ...input.coordinations?.axis }, block: { ...previous.coordinations.block, ...input.coordinations?.block }, dca: { ...previous.coordinations.dca, ...input.coordinations?.dca } },
    })
    if(JSON.stringify(previous)===JSON.stringify(this.state.settings))return
    this.configs = generateStrategyCatalog(this.state.settings.connectionId, this.state.settings.catalog, "1970-01-01T00:00:00.000Z")
    this.refreshSymbolCatalogs()
    this.refreshCoordinationIds()
    this.refreshCurrentLaneIds()
    for (const lane of Object.values(this.state.lanes))this.trimSamples(lane)
  }
  exportState(): EngineState { return structuredClone(this.state) }
  /** Existing retained model outcomes only; never reconstruct an absent exit. */
  retainedLiveCloses():ClosedTrade[]{return structuredClone(this.state.recentLiveTrades??[])}
  private refreshSymbolCatalogs(){
    this.symbolConfigs.clear();this.symbolConfigIds.clear();this.configIds.clear();this.streams.clear();this.signalStreams.clear();this.portedStreams.clear();this.microStreams.clear();this.minuteStreams.clear()
    const cache=new Map<string,{configs:StrategyConfig[];ids:Set<string>}>()
    for(const symbol of this.state.settings.symbols){
      const fees=this.state.settings.symbolFees?.[symbol],identity=JSON.stringify(fees??null)
      let cached=cache.get(identity)
      if(!cached){const configs=fees?generateStrategyCatalog(this.state.settings.connectionId,{...this.state.settings.catalog,...fees},'1970-01-01T00:00:00.000Z'):this.configs;cached={configs,ids:new Set(configs.map(c=>c.id))};cache.set(identity,cached)}
      const {configs,ids}=cached
      this.symbolConfigs.set(symbol,configs);this.symbolConfigIds.set(symbol,ids)
      this.streams.set(symbol,configs.map(config=>({config,key:JSON.stringify([symbol,config.type,config.position_cost_step,...(config.indicationSourceId?[config.indicationSourceId]:[]),...((config.signalTimeframeMinutes??1)!==1?[config.signalTimeframeMinutes]:[])])})))
      const ordinary=new Map<string,ConfigStream>(),groups=new Map<number,Map<string,ConfigStream>>()
      for(const stream of this.streams.get(symbol)!){
        if(!stream.config.indicationSourceId){ordinary.set(stream.key,stream);continue}
        const tf=stream.config.signalTimeframeMinutes??1,group=groups.get(tf)??new Map<string,ConfigStream>();group.set(stream.key,stream);groups.set(tf,group)
      }
      this.signalStreams.set(symbol,[...ordinary.values()])
      this.portedStreams.set(symbol,[...groups].map(([minutes,unique])=>{const streams=[...unique.values()],ids=[...new Set(streams.map(s=>s.config.indicationSourceId!))];return {minutes,stateKey:JSON.stringify([symbol,'ported-sources-v1',minutes]),ids,streams,usesReferences:ids.some(id=>/pair-|market-/.test(id))}}))
      this.microStreams.set(symbol,this.streams.get(symbol)!.filter(({config})=>(config.signalTimeframeMinutes??1)<1))
      this.minuteStreams.set(symbol,this.streams.get(symbol)!.filter(({config})=>(config.signalTimeframeMinutes??1)>=1))
      for(const config of configs)this.configIds.add(config.id)
    }
  }
  serializeState(): string { return JSON.stringify(this.state) }
  private activate(lane: LaneState) {
    if (!this.active.has(lane.symbol)) this.active.set(lane.symbol, new Set())
    this.active.get(lane.symbol)!.add(lane.id)
    const source=(lane.config.signalTimeframeMinutes??1)<1?this.activeMicro:this.activeMinute
    if(!source.has(lane.symbol))source.set(lane.symbol,new Set())
    source.get(lane.symbol)!.add(lane.id)
    if(lane.stage==="live"&&lane.open&&!lane.calculationOnly)this.livePositions.set(lane.open.id,lane)
  }
  private currentLane(lane:LaneState):boolean {
    return this.currentLaneIds.has(lane.id)
  }
  private cachedLane(symbol:string,configId:string,direction:Direction,coordination:Coordination,stage:Stage):LaneState|undefined{
    return this.contexts.get(symbol)?.get(configId)?.[direction][COORDINATION_OFFSET[coordination]+STAGE_INDEX[stage]]
  }
  private cacheLane(lane:LaneState):void{
    let configs=this.contexts.get(lane.symbol);if(!configs){configs=new Map();this.contexts.set(lane.symbol,configs)}
    let context=configs.get(lane.configId);if(!context){context={long:[],short:[]};configs.set(lane.configId,context)}
    context[lane.direction][COORDINATION_OFFSET[lane.coordination]+STAGE_INDEX[lane.stage]]=lane
    if(this.stageScope(lane.config)!=="context")this.configWindows.add(lane,this.configWindowKey(lane))
  }
  private refreshCurrentLaneIds():void {
    const s=this.state.settings
    const symbols=new Set(s.symbols)
    this.currentLaneIds.clear();this.contexts.clear();this.validLineages.clear();this.configWindows=new ConfigStageWindows()
    for(const lane of Object.values(this.state.lanes))if(symbols.has(lane.symbol)&&this.symbolConfigIds.get(lane.symbol)?.has(lane.configId)&&(lane.coordination==="normal"||s.coordinations[lane.coordination].enabled)
      &&lane.id===laneKey(s.connectionId,lane.symbol,lane.config,lane.direction,lane.coordination,lane.stage,this.coordinationIdentity(lane.coordination,lane.stage,lane.config,lane.symbol))){this.currentLaneIds.add(lane.id);this.cacheLane(lane)}
  }
  /** Rechecked after asynchronous exchange preflight, immediately before a new risk write. */
  isLiveIntentEligible(positionId:string,before=Infinity):boolean {
    const lane=this.livePositions.get(positionId)
    if(!lane?.open?.executionEligible||!this.currentLane(lane)||!this.processingAllows(lane))return false
    if(this.realMirror){const real=this.cachedLane(lane.symbol,lane.configId,lane.direction,lane.coordination,'real');if(!lane.open.parentPositionId||real?.open?.id!==lane.open.parentPositionId)return false}
    return this.hasParentEvidence(lane.symbol,lane.config,lane.direction,lane.coordination,"live",false,before,true)&&(lane.coordination!=="axis"||this.axisAllows(lane.symbol,lane.config,lane.direction,"live",before))
  }
  private processingAllows(lane: Pick<LaneState, "config" | "coordination">): boolean {
    const p = strategyProcessing(this.state.settings.catalog, lane.config)
    return (lane.coordination !== "normal" || p.normal) && (lane.config.exitMode === "fixed" || !lane.config.trailing || p.trailing)
  }
  private refreshCoordinationIds(): void {
    const s = this.state.settings
    this.volumeWeights=relationalVolumeSettings(s.catalog.relationalVolumeRatios,true)
    for (const coordination of ["normal", "axis", "block", "dca"] as const) {
      let parameters = coordination === "normal" ? null : s.coordinations[coordination]
      if (parameters && "auto" in parameters && !parameters.auto?.enabled) {
        const { auto: _auto, ...manual } = parameters
        parameters = manual
      }
      this.coordinationIds[coordination] = hashId(JSON.stringify([s.baseNotional, s.volumeFactor,s.volumeRatios?.[coordination]??1,coordination==='axis'?s.volumeRatios?.normal:undefined,s.maxOrderNotional??0, parameters, s.stageLastN, s.stageMinPF,...(s.stageBlocks&&Object.keys(s.stageBlocks).length?[s.stageBlocks]:[])]))
      this.processedCoordinationIds[coordination]=hashId(this.coordinationIds[coordination]+':processed-sets-v1')
    }
  }
  private get processedSets(){return this.state.settings.stageGateMode==='processed-sets'}
  private get realMirror(){return this.processedSets||this.state.settings.liveEntryMode==='real-mirror'}
  private stageScope(config:StrategyConfig):StageWindowScope{
    const {stageWindowScope,microStageWindowScope}=this.state.settings
    return (config.range==="Micro"||config.range==="Low-Range")&&microStageWindowScope&&microStageWindowScope!=="inherit"
      ? microStageWindowScope : stageWindowScope??"context"
  }
  private configWindowKey(lane:LaneState):string{
    const {config,coordination,stage,symbol}=lane
    return JSON.stringify([stage,coordination,config.id,this.coordinationIdentity(coordination,stage,config,symbol)])
  }
  private laneVolumeFactor(coordination:Coordination,config:StrategyConfig,symbol:string):number{
    return normalizedVolumeFactor(this.volumeWeights,{indicationType:config.type,indication:config.indicationSourceId??config.type,strategy:coordination,range:config.range,symbol})
  }
  private coordinationIdentity(coordination: Coordination,stage:Stage='base',config?:StrategyConfig,symbol?:string): string {
    let identity=this.processedSets&&stage!=='base'?this.processedCoordinationIds[coordination]:this.coordinationIds[coordination]
    if(stage==='live'&&!this.processedSets&&this.realMirror)identity+=':real-mirror-v1'
    if(config&&symbol){const factor=this.laneVolumeFactor(coordination,config,symbol);if(factor!==1)identity+=`:weight=${factor}`}
    if(config&&stage!=="base"){const scope=this.stageScope(config);if(scope!=="context")identity+=`:window-scope=${scope}`}
    return coordination==='normal'&&stage==='live'&&config&&!strategyProcessing(this.state.settings.catalog,config).normal?identity+':calculation-only':identity
  }
  /** A decision can exclude the newest same-clock close and still read its full Last-N. */
  private sampleRetention(lane: Pick<LaneState, "stage" | "coordination" | "config">): number {
    const s = this.state.settings
    const source=lane.stage === "live" ? "real" : lane.stage
    const gateWindow = s.stageBlocks?.[source]?blockRequired(s.stageBlocks[source]!):s.stageLastN[source]
    const axisWindow = lane.coordination === "normal" && s.coordinations.axis.enabled&&(s.coordinations.axis.reference!=='base'||lane.stage==='base')
      ? s.coordinations.axis.previous + s.coordinations.axis.last : 0
    return Math.min(s.maxSamples, Math.max(gateWindow, axisWindow)) + 1
  }
  private trimSamples(lane:LaneState):void {
    const retained=this.sampleRetention(lane)
    if(lane.samples.length>retained){lane.samples.length=retained;this.dirtyLaneIds.add(lane.id)}
    if(lane.sampleTimes&&lane.sampleTimes.length>retained){lane.sampleTimes.length=retained;this.dirtyLaneIds.add(lane.id)}
  }
  private contextEvidence(lane: LaneState, before: number): WindowEvidence {
    const times = lane.sampleTimes
    const legacyThrough = lane.untimedSamplesThrough ?? 0
    if (Math.max(times?.[0] ?? 0, legacyThrough) < before) return lane
    let start = 0
    if (times) while (start < times.length && times[start] >= before) start++
    const end = legacyThrough >= before ? times?.length ?? 0 : lane.samples.length
    return {config: lane.config, samples: lane.samples.slice(start, end), closedCount: lane.closedCount}
  }
  private stageWindow(lane:LaneState | undefined,source:"base"|"main"|"real",before:number,exact=false):StageWindowResult {
    const s=this.state.settings,required=s.stageLastN[source],minPF=s.stageMinPF[source],blocks=s.stageBlocks?.[source]
    const scope=lane&&!exact?this.stageScope(lane.config):"context"
    if(!lane||scope==="context")return windowMetrics(lane&&this.contextEvidence(lane,before),required,minPF,blocks)
    const wide=windowMetrics(this.configWindows.evidence(lane,before,blocks?blockRequired(blocks):required),required,minPF,blocks)
    if(scope==="config")return {...wide,windowScope:scope,windowKey:this.configWindowKey(lane)}
    const own=windowMetrics(this.contextEvidence(lane,before),required,minPF,blocks)
    return {...own,windowScope:scope,enoughSamples:own.enoughSamples&&wide.enoughSamples,qualified:own.qualified&&wide.qualified,
      configWindow:{count:wide.count,profitFactor:wide.profitFactor,qualified:wide.qualified}}
  }
  private lane(symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage): LaneState {
    const cached=this.cachedLane(symbol,config.id,direction,coordination,stage);if(cached)return cached
    const id = laneKey(this.state.settings.connectionId, symbol, config, direction, coordination, stage, this.coordinationIdentity(coordination,stage,config,symbol))
    if (!this.state.lanes[id]) {
      this.state.lanes[id] = { id, symbol, configId: config.id, direction, coordination, stage, ...(coordination === "normal" && stage === "live" && !strategyProcessing(this.state.settings.catalog,config).normal ? {calculationOnly:true} : {}), config: Object.freeze(config), samples: [], closedCount: 0, wins: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, lastTimestamp: 0, admissionCount: 0, costTotal:0,admittedClosed:0,admittedProfit:0,admittedLoss:0,admittedNetPnl:0 }
      this.currentLaneIds.add(id)
    }
    this.cacheLane(this.state.lanes[id])
    return this.state.lanes[id]
  }
  private validLineage(lane:LaneState|undefined):boolean{
    if(!lane)return false
    if(this.validLineages.has(lane.id))return true
    const index=STAGES.indexOf(lane.stage),s=this.state.settings
    const scope=this.stageScope(lane.config)
    const valid=index===0||Boolean(lane.parentProof?.length===index&&lane.parentProof.every((proof,i)=>{
      const source=STAGES[i] as "base"|"main"|"real",blocks=s.stageBlocks?.[source]
      const parent=this.cachedLane(lane.symbol,lane.configId,lane.direction,lane.coordination,source)
      const floor=Math.max(s.stageMinPF[source],lane.config.autoPfFloor??0),cap=lane.config.maxWindowDrawdownPct
      if(!parent||proof.stage!==source||proof.laneId!==parent.id||!proof.qualified||(proof.windowScope??"context")!==scope||
        !Number.isFinite(proof.checkedAt)||proof.checkedAt<=0||typeof proof.profitFactor!=="number"||
        !Number.isFinite(proof.profitFactor)||proof.profitFactor<floor||proof.minPF!==floor||
        proof.count!==proof.required||proof.required!==(blocks?blockRequired(blocks):s.stageLastN[source])||
        (proof.blockPolicyKey??null)!==(blocks?blockPolicyKey(blocks):null)||(proof.maxDrawdownPct??0)!==(cap??0))return false
      if(cap!==undefined&&(!Number.isFinite(proof.drawdownPct)||proof.drawdownPct!<0||proof.drawdownPct!>cap))return false
      const wide=proof.configWindow
      return scope!=="both"||Boolean(wide?.qualified&&wide.count===proof.required&&
        typeof wide.profitFactor==="number"&&Number.isFinite(wide.profitFactor)&&wide.profitFactor>=floor)
    }))
    if(valid)this.validLineages.add(lane.id)
    return valid
  }
  private hasParentEvidence(symbol: string, config: StrategyConfig, direction: Direction, coordination: Coordination, stage: Stage,creation=false,before=Infinity,exact=false): boolean {
    if (stage === "base") return true
    if(this.processedSets){
      if(stage!=='live'&&!creation)return this.validLineage(this.cachedLane(symbol,config.id,direction,coordination,stage))
      const parent=STAGES[STAGES.indexOf(stage)-1] as 'base'|'main'|'real',lane=this.cachedLane(symbol,config.id,direction,coordination,parent)
      return this.validLineage(lane)&&this.stageWindow(lane,parent,before,exact).qualified
    }
    for(let i=STAGES.indexOf(stage)-1;i>=0;i--){
      const parent=STAGES[i] as "base"|"main"|"real"
      const lane=this.cachedLane(symbol,config.id,direction,coordination,parent)
      if(!this.stageWindow(lane,parent,before,exact).qualified)return false
    }
    return true
  }
  private axisAllows(symbol: string, config: StrategyConfig, direction: Direction, stage: Stage, before=Infinity): boolean {
    const s = this.state.settings, axis = s.coordinations.axis
    const referenceStage=axis.reference==='base'?'base':stage==='live'&&this.realMirror?'real':stage
    const reference = this.cachedLane(symbol,config.id,direction,'normal',referenceStage)
    if (!reference) return false
    const source = this.contextEvidence(reference,before)
    if (source.samples.length < axis.previous + axis.last) return false
    const threshold = Math.max(referenceStage === "live" ? s.stageMinPF.real : s.stageMinPF[referenceStage],config.autoPfFloor??0)
    const cached=axisCache.get(source),samples=source.samples
    if(cached&&cached.closed===source.closedCount&&cached.samples===samples&&cached.length===samples.length&&cached.head===samples[0]&&cached.previous===axis.previous&&cached.last===axis.last&&cached.outcome===axis.outcome&&cached.threshold===threshold)return cached.allowed
    if(!knownWindow(samples,axis.last+axis.previous)){
      axisCache.set(source,{closed:source.closedCount,samples,length:samples.length,head:samples[0],previous:axis.previous,last:axis.last,outcome:axis.outcome,threshold,allowed:false});return false
    }
    let profit=0,loss=0,lastNet=0
    for(let i=0;i<axis.last;i++)lastNet+=samples[i]
    for(let i=axis.last;i<axis.last+axis.previous;i++){profit+=Math.max(0,samples[i]);loss+=Math.max(0,-samples[i])}
    const allowed=[profit,loss,lastNet].every(Number.isFinite)&&describeProfitFactor(profit,loss,axis.previous).profitFactor>=threshold&&(axis.outcome==='any'||(axis.outcome==='positive'?lastNet>0:lastNet<0))
    axisCache.set(source,{closed:source.closedCount,samples,length:samples.length,head:samples[0],previous:axis.previous,last:axis.last,outcome:axis.outcome,threshold,allowed})
    return allowed
  }
  private open(lane: LaneState, candle: Candle, mirror?:PaperPosition): PaperPosition {
    this.dirtyLaneIds.add(lane.id)
    const s = this.state.settings, block = s.coordinations.block
    const proof=(stage:Stage):GateProof=>{
      const source=stage as 'base'|'main'|'real',parent=this.cachedLane(lane.symbol,lane.configId,lane.direction,lane.coordination,stage),id=parent?.id??''
      const proof=this.stageWindow(parent,source,candle.timestamp)
      return {stage,laneId:id,count:proof.count,required:proof.required,minPF:proof.minPF,profitFactor:proof.profitFactor,pfState:proof.pfState,qualified:proof.qualified,checkedAt:candle.timestamp,...(proof.maxDrawdownPct!==undefined?{drawdownPct:proof.drawdownPct,maxDrawdownPct:proof.maxDrawdownPct}:{}),...("blockPolicyKey" in proof?{blockPolicyKey:proof.blockPolicyKey as string}:{}),...(proof.windowScope?{windowScope:proof.windowScope}:{}),...(proof.configWindow?{configWindow:{...proof.configWindow}}:{})}
    }
    let admission:GateProof[]|undefined
    if(lane.stage!=='base'){
      if(this.processedSets){
        if(lane.stage==='live'||!lane.parentProof){
          const parent=STAGES[STAGES.indexOf(lane.stage)-1],parentLane=this.cachedLane(lane.symbol,lane.configId,lane.direction,lane.coordination,parent)!
          if(!this.validLineage(parentLane))throw new Error('Processed parent has no valid own-set lineage')
          admission=[...(parentLane.parentProof??[]).map(p=>({...p})),proof(parent)]
          lane.parentProof??=admission.map(p=>({...p}))
        }else admission=lane.parentProof.map(p=>({...p}))
        if(!this.validLineage(lane))throw new Error('Processed set lineage does not match this configuration')
      }else admission=STAGES.slice(0,STAGES.indexOf(lane.stage)).map(proof)
    }
    if(admission?.some(proof=>!proof.qualified))throw new Error('Cannot admit a trade without its own qualified parent evidence')
    const total = s.baseNotional * s.volumeFactor*(s.volumeRatios?.[lane.coordination]??1)*this.laneVolumeFactor(lane.coordination,lane.config,lane.symbol)
    const notional = lane.coordination !== "block" ? total : block.behavior==="rounds" ? total*blockRoundBudget(lane,block) : block.mode === "shared" ? total / (1 + block.steps * block.ratio) : total
    const quantity = notional / candle.close
    const position: PaperPosition = {
      id: `${lane.id}@${candle.timestamp}`, activationOrder:++this.state.nextActivationOrder!,openedAt: candle.timestamp, direction: lane.direction,...(admission?{admission}:{}),
      fills: [{ price: candle.close, quantity, timestamp: candle.timestamp, kind: "entry" }], quantity,
      sizing: { baseBudget: total, block: s.coordinations.block, dca: s.coordinations.dca },
      entryPrice: candle.close, peak: candle.close, lastAddPrice: candle.close, addedSteps: 0,
      costPct: lane.config.roundTripCostPct ?? POSITION_COST_PCT_DEFAULT,
      takeProfitPct: lane.config.takeprofit * 100, stopLossPct: lane.config.stoploss * 100,
      exitMode: lane.config.exitMode ?? (lane.config.trailing ? "trailing" : "fixed"), maxHoldMinutes: lane.config.maxHoldMinutes ?? 240, notional,
      trailingBasis: (lane.config.catalogVersion ?? 2)>=3?"peak":"entry",
      trailDistancePct:lane.config.trailDistancePct,exitPolicyVersion:lane.config.catalogVersion??2,maxOrderNotional:s.maxOrderNotional,
    }
    if (lane.coordination === "dca" && s.coordinations.dca.auto?.enabled && !mirror) position.dcaProbePrices = []
    if (lane.coordination === "block" && block.auto?.enabled && !mirror) {
      if (block.behavior === "rounds") position.blockRoundLevel = lane.blockRound?.level ?? 0
      else position.blockProbePrices = []
    }
    if(mirror){
      // Live executes the accepted Real allocation. In particular, its smaller
      // executed subset must not run a second, divergent Block recovery cycle.
      position.fills=mirror.fills.map(fill=>({...fill}));position.quantity=mirror.quantity
      position.notional=mirror.notional;position.entryPrice=mirror.entryPrice;position.sizing=mirror.sizing
    }
    lane.open = position; lane.lastTimestamp = candle.timestamp; lane.admittedAt ??= candle.timestamp; lane.admissionCount++
    this.activate(lane)
    return position
  }
  private close(lane: LaneState, candle: Candle, reason: string): ClosedTrade {
    this.dirtyLaneIds.add(lane.id)
    const open = lane.open!, sign = lane.direction === "long" ? 1 : -1
    const grossPnl = sign * (candle.close - open.entryPrice) * open.quantity
    // Expected fees+slippage at recorded entry notional. Exchange settlements remain separate.
    const cost = open.notional * open.costPct / 100, netPnl = grossPnl - cost
    const netReturnPct = netPnl / open.notional * 100
    const trade: ClosedTrade = { id: open.id, laneId: lane.id, configId: lane.configId, symbol: lane.symbol, direction: lane.direction, stage: lane.stage, coordination: lane.coordination,
      openedAt: open.openedAt, closedAt: candle.timestamp, entryPrice: open.entryPrice, exitPrice: candle.close,
      quantity: open.quantity, notional: open.notional, grossPnl, cost, netPnl, netReturnPct, reason, fills: open.fills.map(f=>({...f})), source: "paper",...(open.admission?{admission:open.admission.map(p=>({...p}))}:{}),...(open.parentPositionId?{parentPositionId:open.parentPositionId}:{}) }
    if (lane.coordination === "block") {
      if (open.sizing?.block.behavior === "rounds" && !(this.processedSets && lane.stage === "live")) settleBlockRound(lane, netPnl, open.sizing.block)
      settleBlockSteps(lane, open, candle.close, netReturnPct)
    }
    if (lane.coordination === "dca") settleDcaSteps(lane, open, candle.close)
    lane.samples.unshift(netReturnPct)
    const sampleTimes = lane.sampleTimes ??= []
    sampleTimes.unshift(candle.timestamp)
    this.configWindows.settled(lane,candle.timestamp)
    this.trimSamples(lane)
    lane.closedCount++; lane.wins += netPnl > 0 ? 1 : 0; lane.netPnl += netPnl
    if(lane.costTotal!==undefined)lane.costTotal+=cost
    lane.grossProfit += Math.max(0, netReturnPct); lane.grossLoss += Math.max(0, -netReturnPct)
    if(lane.stage!=='base'&&open.admission?.length===STAGES.indexOf(lane.stage)&&open.admission.every(p=>p.qualified)){
      lane.admittedClosed=(lane.admittedClosed??0)+1;lane.admittedProfit=(lane.admittedProfit??0)+Math.max(0,netReturnPct);lane.admittedLoss=(lane.admittedLoss??0)+Math.max(0,-netReturnPct);lane.admittedNetPnl=(lane.admittedNetPnl??0)+netPnl
    }
    lane.open = undefined; this.active.get(lane.symbol)?.delete(lane.id)
    this.activeMicro.get(lane.symbol)?.delete(lane.id);this.activeMinute.get(lane.symbol)?.delete(lane.id)
    if (!lane.calculationOnly) { this.state.recentTrades.unshift(trade); this.state.recentTrades.length = Math.min(this.state.recentTrades.length, this.maxRecentTrades) }
    if (lane.stage === "live" && !lane.calculationOnly) {
      this.livePositions.delete(open.id)
      this.state.recentLiveTrades!.unshift(trade);this.state.recentLiveTrades!.length=Math.min(this.state.recentLiveTrades!.length,this.maxRecentTrades)
      this.state.equity += netPnl; this.state.peakEquity = Math.max(this.state.peakEquity, this.state.equity)
      const dd = this.state.peakEquity > 0 ? 100 * (this.state.peakEquity - this.state.equity) / this.state.peakEquity : 0
      this.state.maxDrawdownPct = Math.max(this.state.maxDrawdownPct, dd)
      this.state.equityHistory.push({ timestamp: candle.timestamp, equity: this.state.equity, drawdownPct: dd })
      if (this.state.equityHistory.length > 1000) this.state.equityHistory.shift()
    }
    if(lane.stage==='live')this.liveCloseObserver?.(trade)
    return trade
  }
  private mark(lane: LaneState, candle: Candle, ordered=false): EngineEvent | undefined {
    const open = lane.open
    if (!open || candle.timestamp<open.openedAt || (!ordered&&candle.timestamp===open.openedAt) || candle.timestamp<lane.lastTimestamp || (!ordered&&candle.timestamp===lane.lastTimestamp)) return
    this.dirtyLaneIds.add(lane.id)
    lane.lastTimestamp = candle.timestamp
    const sign = lane.direction === "long" ? 1 : -1
    const exit=observedExit(open,{trailingEnabled:strategyProcessing(this.state.settings.catalog,lane.config).trailing,price:candle.close,timestamp:candle.timestamp,trailingBasis:open.trailingBasis??((lane.config.catalogVersion??2)>=3?"peak":"entry")})
    open.peak=exit.peak
    if((open.exitPolicyVersion??3)>=4){open.trailingActive=exit.trailingActive;if(exit.trailingActive)open.trailingStopPrice=exit.stop}
    const reason=exit.reason
    if (reason) return { type: "closed", laneId: lane.id, timestamp: candle.timestamp, stage: lane.stage, trade: this.close(lane, candle, reason) }
    if(!this.symbolConfigIds.get(lane.symbol)?.has(lane.configId)||(lane.coordination!=="normal"&&!this.state.settings.coordinations[lane.coordination].enabled)||(lane.stage==="live"&&(!this.currentLane(lane)||!this.processingAllows(lane))))return
    if(lane.stage==="live"&&open.parentPositionId&&(lane.coordination==="block"||lane.coordination==="dca")){
      const real=this.cachedLane(lane.symbol,lane.configId,lane.direction,lane.coordination,"real")?.open
      const fill=real?.fills[open.addedSteps+1]
      // Real is processed first. Project its exact add, including the price on equal-clock ticks.
      if(!real||real.id!==open.parentPositionId||real.addedSteps!==open.addedSteps+1||fill?.kind!==lane.coordination||
        fill.timestamp!==candle.timestamp||fill.price!==candle.close)return
      open.fills.push({...fill});open.notional=real.notional;open.quantity=real.quantity;open.entryPrice=real.entryPrice
      open.lastAddPrice=real.lastAddPrice;open.addedSteps=real.addedSteps
      return {type:"added",laneId:lane.id,timestamp:candle.timestamp,stage:lane.stage}
    }
    const s = this.state.settings
    const sizing = open.sizing ?? { baseBudget: s.baseNotional * s.volumeFactor, block: s.coordinations.block, dca: s.coordinations.dca }
    let addNotional = 0, kind: "block" | "dca" = "block"
    const block = sizing.block
    if (lane.coordination === "block" && block.behavior !== "rounds" && open.addedSteps < block.steps &&
      (!block.auto?.enabled || this.currentLane(lane)) && checkBlockPyramidAdd(lane, open, candle.close, block)) {
      addNotional = sizing.baseBudget * block.ratio / (block.mode === "shared" ? 1 + block.steps * block.ratio : 1)
    }
    if (lane.coordination === "dca" && open.addedSteps < sizing.dca.steps) {
      const auto = sizing.dca.auto
      let allowed: boolean
      if (auto?.enabled) {
        if (!this.currentLane(lane)) return
        const step = observeDcaStep(open, candle.close, sizing.dca.steps, sizing.dca.distancePct)
        allowed = step === open.addedSteps + 1 && dcaStepVerdict(lane, step, auto).state === "qualified"
      } else {
        const adverse = -sign * (candle.close - open.lastAddPrice) / open.lastAddPrice * 100
        allowed = adverse >= sizing.dca.distancePct
      }
      if (allowed) { addNotional = sizing.baseBudget * sizing.dca.multiplier; kind = "dca" }
    }
    if (addNotional > 0) {
      const quantity = addNotional / candle.close
      open.fills.push({ price: candle.close, quantity, timestamp: candle.timestamp, kind })
      open.notional += addNotional; open.quantity += quantity; open.entryPrice = open.notional / open.quantity
      open.lastAddPrice = candle.close; open.addedSteps++
      return { type: "added", laneId: lane.id, timestamp: candle.timestamp, stage: lane.stage }
    }
  }
  private enqueueIntent(lane: LaneState, position: PaperPosition, candle: Candle, kind: "entry" | "add" | "close", requestedQuantity: number): void {
    const id = `ctsc_${hashId(`${position.id}:${kind}:${candle.timestamp}:${position.addedSteps}`)}`
    if (this.state.intents.some(intent => intent.id === id)) return
    this.state.intents.push({ id, kind, positionId: position.id, requestedQuantity,
      connectionId: this.state.settings.connectionId, laneId: lane.id, configId: lane.configId, symbol: lane.symbol, direction: lane.direction,
      timestamp: candle.timestamp, price: candle.close, notional: requestedQuantity * candle.close,
      takeProfitPct: position.takeProfitPct, stopLossPct: position.stopLossPct, exitMode: position.exitMode,maxOrderNotional:position.maxOrderNotional,qualificationId:position.admission?.length?hashId(JSON.stringify(position.admission)):undefined,
      ...(((lane.coordination==='block'&&position.sizing?.block.behavior!=='rounds')||lane.coordination==='dca')?{minimumAddRatio:lane.coordination==='block'?position.sizing?.block.ratio:position.sizing?.dca.multiplier}:{}),...(position.parentPositionId?{realPositionId:position.parentPositionId}:{}),source: "real-qualified", status: "pending" })
    if(kind==='entry'&&lane.coordination==='block'&&position.sizing?.block.behavior==='rounds')this.state.intents.at(-1)!.entryAllocationRatio=position.notional/position.sizing.baseBudget
  }
  processCandles(symbolInput: string, candles: Candle[], options: { allowExecution?: boolean;eventLimit?:number;barSeconds?:10|60 } = {}): EngineEvent[] {
    const symbol = normalizeSymbol(symbolInput), s = this.state.settings
    const configured=s.symbols.includes(symbol)
    const micro=options.barSeconds===10,cursors=micro?(this.state.lastMicroTimestamp??={}):this.state.lastTimestamp
    if (!configured&&!this.active.get(symbol)?.size) throw new Error(`Symbol ${symbol} is not configured`)
    const events: EngineEvent[] = []
    const eventLimit=options.eventLimit??Infinity
    if(eventLimit!==Infinity&&(!Number.isInteger(eventLimit)||eventLimit<0))throw new Error('Invalid event limit')
    let eventIndex=0
    const emit=(event:EngineEvent)=>{if(eventLimit===0)return;if(events.length<eventLimit)events.push(event);else{events[eventIndex]=event;eventIndex=(eventIndex+1)%eventLimit}}
    // Validate the complete batch before any mutation, so rejected input is atomic.
    validateObservedCandles(candles)
    const historicalSignals=new Map<string,ReturnType<typeof historicalPortedSignals>>()
    if(configured&&!micro&&!options.allowExecution&&candles.length>1){
      const unseen=candles.filter(c=>c.timestamp>(this.state.lastTimestamp[symbol]??0))
      if(unseen.length>1)for(const group of this.portedStreams.get(symbol)??[])if(group.minutes>=1&&!group.usesReferences){
        const state=this.state.signals[group.stateKey]??=newSignalState()
        historicalSignals.set(group.stateKey,historicalPortedSignals(state,unseen,group.minutes,group.ids,symbol))
      }
    }
    for (const candle of candles) {
      if (candle.timestamp <= (cursors[symbol] ?? 0)) continue
      for (const id of (micro?this.activeMicro:this.activeMinute).get(symbol) ?? []) {
        const lane = this.state.lanes[id], position = lane.open!
        // A source candle may manage only its own timeframe family. Present-time
        // 10s bars cannot settle minute positions inside historical recovery.
        if(micro!==((lane.config.signalTimeframeMinutes??1)<1))continue
        const event = this.mark(lane, candle)
        if (event) {
          if (!lane.calculationOnly) emit(event)
          if (lane.stage === "live" && position.executionEligible) {
            if (event.type === "closed") this.enqueueIntent(lane, position, candle, "close", position.quantity)
            if (event.type === "added") this.enqueueIntent(lane, position, candle, "add", position.fills.at(-1)!.quantity)
          }
        }
      }
      if(!configured){cursors[symbol]=candle.timestamp;this.state.updatedAt=Math.max(this.state.updatedAt,candle.timestamp);this.state.processedCandles++;continue}
      const signals = new Map<string, Direction | undefined>()
      const streams=(micro?this.microStreams:this.minuteStreams).get(symbol)??[]
      for (const {config,key} of (this.signalStreams.get(symbol)??[]).filter(({config})=>((config.signalTimeframeMinutes??1)<1)===micro)) {
        if (!signals.has(key)) {
          const state = this.state.signals[key] ??= newSignalState()
          signals.set(key, advanceConfiguredSignal(state,candle,config))
        }
      }
      for(const group of this.portedStreams.get(symbol)??[]){
        if((group.minutes<1)!==micro)continue
        const state=this.state.signals[group.stateKey]??=newSignalState()
        const peers=group.usesReferences?s.symbols.filter(peer=>peer!==symbol).flatMap(peer=>{const rows=this.state.signals[JSON.stringify([peer,'ported-sources-v1',group.minutes])]?.portedBars;return rows?[{symbol:peer,bars:rows.filter(row=>row.timestamp<=candle.timestamp)}]:[]}):[]
        const output=historicalSignals.has(group.stateKey)?historicalSignals.get(group.stateKey)!.get(candle.timestamp)??new Map<string,Direction|undefined>():advancePortedSources(state,candle,group.minutes,group.ids,{symbol,peers})
        for(const {config,key} of group.streams)signals.set(key,output.get(config.indicationSourceId!))
      }
      for (const {config,key} of streams) {
        const signal = signals.get(key)
        if (!signal) continue
        const coordinations: Coordination[] = ["normal"]
        if (s.coordinations.axis.enabled) coordinations.push("axis")
        if (s.coordinations.block.enabled) coordinations.push("block")
        if (s.coordinations.dca.enabled) coordinations.push("dca")
        for (const coordination of coordinations) {
          let realPositionId:string|undefined
          for (const stage of STAGES) {
            // Disabled Normal keeps an internal reference for same-stage Axis; it never receives execution funding.
            let lane=this.cachedLane(symbol,config.id,signal,coordination,stage)
            const axisReady=coordination!=="axis"||this.axisAllows(symbol,config,signal,stage,candle.timestamp)
            const parentReady=!this.processedSets||this.hasParentEvidence(symbol,config,signal,coordination,stage,!lane,candle.timestamp)
            const mirrorReady=!this.realMirror||stage!=='live'||Boolean(realPositionId)
            if(axisReady&&parentReady&&mirrorReady&&!lane?.open&&(!lane||lane.lastTimestamp<candle.timestamp)){
              lane??=this.lane(symbol, config, signal, coordination, stage)
              if(coordination==='block'&&s.coordinations.block.behavior==='rounds'&&!(this.realMirror&&stage==='live')&&consumeBlockPause(lane,s.coordinations.block)){
                this.dirtyLaneIds.add(lane.id)
                if(!this.processedSets&&stage!=='live'&&!this.stageWindow(lane,stage,candle.timestamp).qualified)break
                continue
              }
              const mirror=this.realMirror&&stage==='live'?this.cachedLane(symbol,config.id,signal,coordination,'real')?.open:undefined
              const position = this.open(lane, candle,mirror)
              if(stage==='real')realPositionId=position.id
              if(this.realMirror&&stage==='live')position.parentPositionId=realPositionId
              if (!lane.calculationOnly) emit({ type: "opened", laneId: lane.id, timestamp: candle.timestamp, stage })
              if (stage === "live" && !lane.calculationOnly && options.allowExecution) {
                position.executionEligible = true
                if(this.stageScope(config)==="context"||this.isLiveIntentEligible(position.id,candle.timestamp))this.enqueueIntent(lane, position, candle, "entry", position.quantity)
                else position.executionEligible=false
              }
            }
            // No downstream stage can admit when any preceding gate fails.
            if(!this.processedSets&&stage!=="live"&&!this.stageWindow(lane,stage,candle.timestamp).qualified)break
          }
        }
      }
      cursors[symbol] = candle.timestamp; this.state.updatedAt = Math.max(this.state.updatedAt, candle.timestamp); this.state.processedCandles++
    }
    return eventIndex?[...events.slice(eventIndex),...events.slice(0,eventIndex)]:events
  }
  /** Process multi-symbol research candles in one causal order. All series are checked before mutation. */
  processMarketCandles(series: Readonly<Record<string, readonly Candle[]>>): void {
    const entries=Object.entries(series).map(([symbol,bars])=>({symbol:normalizeSymbol(symbol),bars,index:0}))
    const allowed=new Set(this.managedSymbols()), seen=new Set<string>()
    for(const {symbol,bars} of entries){
      if(!allowed.has(symbol)||seen.has(symbol))throw new Error("Invalid market candle symbol")
      seen.add(symbol);validateObservedCandles(bars)
      const cursor=this.state.lastTimestamp[symbol]??0
      const firstNew=bars.find(bar=>bar.timestamp>cursor)
      if(firstNew&&firstNew.timestamp<=this.state.updatedAt)throw new Error("Market candle batch overlaps the decision clock")
    }
    entries.sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0)
    for(;;){
      let first:typeof entries[number]|undefined
      for(const entry of entries)if(entry.index<entry.bars.length&&(!first||entry.bars[entry.index].timestamp<first.bars[first.index].timestamp))first=entry
      if(!first)return
      this.processCandles(first.symbol,[first.bars[first.index++]],{eventLimit:0})
    }
  }
  /** Manage existing positions on observed quote ticks; signals remain closed-bar only. */
  processTick(symbolInput: string, price: number, timestamp: number, ordered=false, scope:"all"|"micro"="all"): EngineEvent[] {
    const symbol = normalizeSymbol(symbolInput)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Invalid observed quote")
    const candle: Candle = { timestamp, open: price, high: price, low: price, close: price, volume: 0 }
    const events: EngineEvent[] = []
    for (const id of (scope==='micro'?this.activeMicro:this.active).get(symbol) ?? []) {
      const lane = this.state.lanes[id], position = lane.open!
      if(scope==="micro"&&(lane.config.signalTimeframeMinutes??1)>=1)continue
      const event = this.mark(lane, candle, ordered)
      if (!event) continue
      if (!lane.calculationOnly) events.push(event)
      if (lane.stage === "live" && position.executionEligible) {
        if (event.type === "closed") this.enqueueIntent(lane, position, candle, "close", position.quantity)
        if (event.type === "added") this.enqueueIntent(lane, position, candle, "add", position.fills.at(-1)!.quantity)
      }
    }
    this.state.updatedAt = Math.max(this.state.updatedAt, timestamp)
    return events
  }
  pendingIntents(): ExecutionIntent[] { return structuredClone(this.state.intents.filter(i => i.status === "pending")) }
  markExecution(id: string, result: { status: "acknowledged" | "rejected"; exchangeOrderId?: string; error?: string }): void {
    const intent = this.state.intents.find(i => i.id === id)
    if (!intent) throw new Error("Execution intent not found")
    if (intent.status !== "pending") return
    Object.assign(intent, result)
    const settled = this.state.intents.filter(i => i.status !== "pending")
    if (settled.length > 1000) { const remove = new Set(settled.slice(0, settled.length - 1000).map(i => i.id)); this.state.intents = this.state.intents.filter(i => !remove.has(i.id)) }
  }
  activePositionIds(): Set<string> {
    const ids = new Set<string>()
    for (const lanes of this.active.values()) for (const id of lanes) {
      const lane = this.state.lanes[id], position = lane.open
      if (position && !lane.calculationOnly) ids.add(position.id)
    }
    return ids
  }
  hasOpenPositions(): boolean { return [...this.active.values()].some(lanes => [...lanes].some(id=>!this.state.lanes[id].calculationOnly)) }
  coordinationStats(){
    const coordinations=['normal','axis','block','dca'] as const
    const rows=STAGES.flatMap(stage=>coordinations.map(coordination=>({stage,coordination,lanes:0,closed:0,enoughSamples:0,profit:0,loss:0,netPnl:0,notionalFactor:this.state.settings.volumeRatios?.[coordination]??1})))
    const byId=new Map(rows.map(row=>[`${row.stage}:${row.coordination}`,row]))
    for(const lane of Object.values(this.state.lanes)){
      if(!this.currentLane(lane)||lane.calculationOnly)continue
      const row=byId.get(`${lane.stage}:${lane.coordination}`)!,source=lane.stage==='live'?'real':lane.stage
      row.lanes++;row.closed+=lane.closedCount;row.profit+=lane.grossProfit;row.loss+=lane.grossLoss;row.netPnl+=lane.netPnl
      row.enoughSamples+=Number(this.stageWindow(lane,source,Infinity).enoughSamples)
    }
    return rows.map(({profit,loss,...row})=>{
      const own=describeProfitFactor(profit,loss,row.closed),normal=byId.get(`${row.stage}:normal`)!,baseline=describeProfitFactor(normal.profit,normal.loss,normal.closed)
      return {...row,...own,samplesPercent:row.lanes?100*row.enoughSamples/row.lanes:null,normalPF:baseline.profitFactor,normalPfState:baseline.pfState,normalCloses:normal.closed,pfRatio:own.pfState==='finite'&&baseline.pfState==='finite'&&baseline.profitFactor>0?own.profitFactor/baseline.profitFactor:null}
    })
  }
  snapshot(options: { laneLimit?: number; positionLimit?: number; positionStage?: Stage } = {}): EngineSnapshot {
    const laneLimit = options.laneLimit ?? Infinity, positionLimit = options.positionLimit ?? Infinity
    for (const limit of [laneLimit, positionLimit]) if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new Error("Invalid snapshot limit")
    const s = this.state.settings
    const lanes: EngineSnapshot["lanes"] = [], positions: EngineSnapshot["positions"] = []
    const stageStats = Object.fromEntries(STAGES.map(stage => [stage, { stage, lanes: 0, open: 0, closed: 0, enoughSamples: 0, enoughSamplesPct: 0, qualified: 0, profitFactor: 1, netPnl: 0, profit: 0, loss: 0,wins:0,fees:0 as number|null,longOpen:0,shortOpen:0,currentLanes:0,currentEnoughSamples:0,currentQualified:0,admissionReady:0,blockedByParent:0,currentProfit:0,currentLoss:0,currentCount:0,currentUnknown:0,validatedProfit:0,validatedLoss:0,validatedCount:0,validatedSets:0,admittedCount:0,admittedProfit:0,admittedLoss:0,admittedNet:0 }])) as Record<Stage,StageMetricsAccumulator>
    const currentWindows=new Set<string>(), validatedWindows=new Set<string>()
    for (const lane of Object.values(this.state.lanes)) {
      if (lane.calculationOnly) continue
      const source = lane.stage === "live" ? "real" : lane.stage
      const current=this.currentLane(lane)
      const {windowKey,...metrics}:StageWindowResult = current ? this.stageWindow(lane,source,Infinity)
        : windowMetrics(lane,s.stageLastN[source],s.stageMinPF[source],s.stageBlocks?.[source])
      const stats = stageStats[lane.stage]
      stats.lanes++; stats.open += lane.open ? 1 : 0; stats.closed += lane.closedCount
      stats.enoughSamples += metrics.enoughSamples ? 1 : 0; stats.qualified += metrics.qualified ? 1 : 0
      stats.profit += lane.grossProfit; stats.loss += lane.grossLoss; stats.netPnl += lane.netPnl
      stats.wins+=lane.wins
      stats.admittedCount+=lane.admittedClosed??0;stats.admittedProfit+=lane.admittedProfit??0;stats.admittedLoss+=lane.admittedLoss??0;stats.admittedNet+=lane.admittedNetPnl??0
      if(stats.fees!==null){if(lane.closedCount&&lane.costTotal===undefined)stats.fees=null;else stats.fees+=lane.costTotal??0}
      if(lane.open)stats[lane.direction==="long"?"longOpen":"shortOpen"]++
      const parentReady=current&&this.hasParentEvidence(lane.symbol,lane.config,lane.direction,lane.coordination,lane.stage)
      const axisReady=current&&(lane.coordination!=="axis"||this.axisAllows(lane.symbol,lane.config,lane.direction,lane.stage))
      const validated=metrics.qualified&&parentReady&&axisReady
      if(current){
        stats.currentLanes++;stats.currentEnoughSamples+=Number(metrics.enoughSamples)
        stats.admissionReady+=Number(parentReady&&axisReady)
        stats.blockedByParent+=Number(!parentReady)
        stats.currentQualified+=Number(validated)
        if(validated&&(!windowKey||!validatedWindows.has(windowKey))){
          if(windowKey)validatedWindows.add(windowKey)
          stats.validatedSets++;stats.validatedProfit+=metrics.profit??0;stats.validatedLoss+=metrics.loss??0;stats.validatedCount+=metrics.pfSampleCount??metrics.count
        }
        if(!windowKey||!currentWindows.has(windowKey)){
          if(windowKey)currentWindows.add(windowKey)
          if(metrics.pfState==='unknown')stats.currentUnknown++
          else {stats.currentProfit+=metrics.profit??0;stats.currentLoss+=metrics.loss??0;stats.currentCount+=metrics.pfSampleCount??metrics.count}
        }
      }
      if (lanes.length < laneLimit) lanes.push({ id: lane.id, symbol: lane.symbol, configId: lane.configId, stage: lane.stage, direction: lane.direction, coordination: lane.coordination, ...metrics, current,admissionReady:parentReady&&axisReady,validated,isOpen:Boolean(lane.open),netPnl: lane.netPnl })
      if (lane.open && (!options.positionStage || options.positionStage === lane.stage) && positions.length < positionLimit) positions.push({ ...lane.open, laneId: lane.id, symbol: lane.symbol, configId: lane.configId, stage: lane.stage, coordination: lane.coordination })
    }
    const stages = STAGES.map(stage => {
      const { profit, loss,currentProfit,currentLoss,currentCount,currentUnknown,validatedProfit,validatedLoss,validatedCount,validatedSets,admittedCount,admittedProfit,admittedLoss,admittedNet, ...stats } = stageStats[stage]
      stats.enoughSamplesPct = stats.lanes ? 100 * stats.enoughSamples / stats.lanes : 0
      const current=currentUnknown?{profitFactor:null,pfState:'unknown' as const}:describeProfitFactor(currentProfit,currentLoss,currentCount)
      return { ...stats, ...describeProfitFactor(profit, loss, stats.closed),currentProfitFactor:current.profitFactor,currentPfState:current.pfState,validatedWindow:{samples:validatedCount,sets:validatedSets,profit:validatedProfit,loss:validatedLoss,...describeProfitFactor(validatedProfit,validatedLoss,validatedCount)},admittedForward:{closes:admittedCount,...describeProfitFactor(admittedProfit,admittedLoss,admittedCount),netPnl:admittedNet,unprovenCloses:stats.closed-admittedCount} }
    })
    return structuredClone({ settings: s, catalogCount: this.configs.length, symbolCount: s.symbols.length, processedCandles: this.state.processedCandles, updatedAt: this.state.updatedAt,
      equity: this.state.equity, peakEquity: this.state.peakEquity, maxDrawdownPct: this.state.maxDrawdownPct, stages,
      positions, trades: this.state.recentTrades,liveTrades:this.state.recentLiveTrades!, intents: this.state.intents, equityHistory: this.state.equityHistory, lanes })
  }
}
// Deterministic client IDs survive restart and retries; credentials are never inputs.
function hashId(text: string): string { return createHash("sha256").update(text).digest("hex").slice(0, 32) }
type StageMetricsAccumulator = Omit<import("./types").StageMetrics,"pfState"|"currentProfitFactor"|"currentPfState"> & {profit:number;loss:number;currentProfit:number;currentLoss:number;currentCount:number;currentUnknown:number;validatedProfit:number;validatedLoss:number;validatedCount:number;validatedSets:number;admittedCount:number;admittedProfit:number;admittedLoss:number;admittedNet:number}
