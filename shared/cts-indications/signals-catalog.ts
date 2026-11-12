import sources from './signals-sources.json'

/** Pure metadata/identities, safe to share with Settings without importing indicator computations. */
export const SIGNAL_SOURCES = sources
export const SIGNAL_RATIOS = [.6,.65,.7,.75,.8] as const
const pools:Record<string,string[]>={
  Trend:['ema-cross','ema-trend','adx','supertrend','hma'],
  Momentum:['macd-cross','macd-hist','rsi-momentum','trix','impulse'],
  Breakout:['donchian','keltner','atr-break','squeeze','volume-break'],
  Volume:['vwap','mfi','obv','cmf','volume-break'],
  Mixed:['ema-cross','rsi-momentum','donchian','adx','vwap'],
}
export function signalsCoordinationId(names:readonly string[],ratio:number,minSources:number,mask:number){
  if(!SIGNAL_RATIOS.includes(ratio as typeof SIGNAL_RATIOS[number])||![2,3,5].includes(minSources)||![1,2,3].includes(mask))throw Error('Invalid Signals coordination')
  const unique=new Set(names);if(unique.size<minSources||names.some(n=>!sources.some(s=>s.name===n)))throw Error('Invalid Signals source pool')
  let bits=0n;for(const [i,s]of sources.entries())if(unique.has(s.name))bits|=1n<<BigInt(i)
  return `sig-coord-v2-r${Math.round(ratio*100)}-n${minSources}-i${mask}-b${bits.toString(36)}`
}
export const SIGNALS_CATALOG:readonly {id:string;label:string;category:string;variant:string}[]=[
  ...sources.flatMap(s=>['short','medium'].map(variant=>({id:s[variant as 'short'|'medium'],label:`${s.label} · ${variant}`,category:s.name.startsWith('r-')?'Research':s.name.startsWith('s2-')?'Legacy':'Source',variant}))),
  ...Object.entries(pools).flatMap(([category,names])=>SIGNAL_RATIOS.flatMap(ratio=>[2,3,5].flatMap(min=>[1,2,3].map(mask=>({id:signalsCoordinationId(names,ratio,min,mask),label:`${category} · ${Math.round(ratio*100)}% band · minimum ${min} sources · ${mask===1?'short':mask===2?'medium':'both'}`,category,variant:'coordination'})))))
]
export const SIGNALS_BY_ID=new Map(SIGNALS_CATALOG.map(s=>[s.id,s]))
export const DEFAULT_SIGNALS_SOURCES=['sig-ema-cross-s','sig-rsi-reversal-s','sig-donchian-s','sig-macd-cross-m','sig-vwap-s',signalsCoordinationId(pools.Mixed,.8,3,3)]
export function checkedSignalsSources(value:unknown=DEFAULT_SIGNALS_SOURCES):string[]{
 const values=typeof value==='string'?JSON.parse(value):value
 if(!Array.isArray(values)||!values.length||new Set(values).size!==values.length||values.some(id=>typeof id!=='string'||!SIGNALS_BY_ID.has(id)))throw Error('Choose valid, unique Signals sources')
 return [...values]
}
