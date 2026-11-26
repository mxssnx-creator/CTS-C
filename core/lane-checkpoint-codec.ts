import type { GateProof, LaneState, StrategyConfig } from "./types"

type JsonRecord=Record<string,unknown>

const LANE_KEYS:Record<string,string>={
  calculationOnly:"z",baseObservation:"bc",blockRound:"b",dcaStepReturns:"j",blockStepReturns:"v",
  symbol:"s",direction:"d",stage:"g",coordination:"o",samples:"a",closedCount:"n",wins:"w",
  netPnl:"p",grossProfit:"f",grossLoss:"l",sampleTimes:"m",untimedSamplesThrough:"u",
  open:"x",admittedAt:"h",lastTimestamp:"t",admissionCount:"q",costTotal:"k",
  admittedClosed:"ec",admittedProfit:"ep",admittedLoss:"el",admittedNetPnl:"en",
  executed:"ex",postStage:"ps",relateTrials:"rt",
}
const PROOF_KEYS:Record<string,string>={
  stage:"g",laneId:"i",count:"n",required:"r",minPF:"m",profitFactor:"p",pfState:"s",
  qualified:"q",checkedAt:"t",blockPolicyKey:"b",drawdownPct:"d",maxDrawdownPct:"x",
  windowScope:"w",autoPf:"a",
}
const WINDOW_KEYS:Record<string,string>={count:"n",profitFactor:"p",qualified:"q"}
const invert=(mapping:Record<string,string>)=>Object.fromEntries(Object.entries(mapping).map(([key,value])=>[value,key]))
const LANE_LONG=invert(LANE_KEYS),PROOF_LONG=invert(PROOF_KEYS),WINDOW_LONG=invert(WINDOW_KEYS)
const own=(value:unknown):value is JsonRecord=>!!value&&typeof value==="object"&&!Array.isArray(value)
const rename=(source:JsonRecord,mapping:Record<string,string>,reserved:Set<string>):JsonRecord=>{
  const target:JsonRecord={}
  for(const [key,value] of Object.entries(source)){
    const renamed=mapping[key]??key
    if(!mapping[key]&&reserved.has(key))throw new Error(`Checkpoint codec key collision: ${key}`)
    if(renamed in target)throw new Error(`Duplicate checkpoint codec key: ${renamed}`)
    target[renamed]=value
  }
  return target
}
const expand=(source:JsonRecord,mapping:Record<string,string>):JsonRecord=>{
  const target:JsonRecord={}
  for(const [key,value] of Object.entries(source)){
    const expanded=mapping[key]??key
    if(expanded in target)throw new Error(`Duplicate expanded checkpoint key: ${expanded}`)
    target[expanded]=value
  }
  return target
}
const laneReserved=new Set([...Object.values(LANE_KEYS),"c","r"])
const proofReserved=new Set([...Object.values(PROOF_KEYS),"c"])
const windowReserved=new Set(Object.values(WINDOW_KEYS))

const compactWindow=(window:GateProof["configWindow"]):unknown=>
  window?rename(window as unknown as JsonRecord,WINDOW_KEYS,windowReserved):window
const expandWindow=(window:unknown):GateProof["configWindow"]=>{
  if(window===undefined)return undefined
  if(!own(window))throw new Error("Invalid compact config window")
  return expand(window,WINDOW_LONG) as unknown as GateProof["configWindow"]
}
const compactProof=(proof:GateProof):JsonRecord=>{
  const {configWindow,...plain}=proof
  const compact=rename(plain as unknown as JsonRecord,PROOF_KEYS,proofReserved)
  if(configWindow!==undefined)compact.c=compactWindow(configWindow)
  return compact
}
const expandProof=(proof:unknown):GateProof=>{
  if(!own(proof))throw new Error("Invalid compact parent proof")
  const {c,...plain}=proof
  const expanded=expand(plain,PROOF_LONG)
  if(c!==undefined)expanded.configWindow=expandWindow(c)
  return expanded as unknown as GateProof
}

/** V4 stores exact lane values while replacing repeated schema names with stable short keys. */
export function compactLaneV4(lane:LaneState):JsonRecord{
  const {id:_id,config:_config,configId,parentProof,...mutable}=lane
  const compact=rename(mutable as unknown as JsonRecord,LANE_KEYS,laneReserved)
  compact.c=configId
  if(parentProof!==undefined)compact.r=parentProof.map(compactProof)
  return compact
}

/** Expand one trusted v4 row and reject ambiguous or embedded lane/config identities. */
export function expandLaneV4(value:unknown,id:string,config:StrategyConfig):LaneState{
  if(!own(value)||typeof value.c!=="string"||config.id!==value.c||
      "id" in value||"config" in value||"configId" in value||"parentProof" in value)
    throw new Error("Compact v4 lane identity mismatch")
  for(const key of Object.keys(LANE_KEYS))if(key in value)throw new Error("Uncompacted v4 lane key")
  const {c:configId,r,...plain}=value
  const mutable=expand(plain,LANE_LONG)
  if(r!==undefined){
    if(!Array.isArray(r))throw new Error("Invalid compact parent proof chain")
    mutable.parentProof=r.map(expandProof)
  }
  return {...mutable,id,configId,config} as unknown as LaneState
}
