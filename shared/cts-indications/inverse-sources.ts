import { PORTED_CATALOG } from "./catalog"

const sourceIds = ["trend-ema", "trend-adx", "break-don20", "act-burst", "rsi-mom-14-20",
  "bb-walk", "sar-std", "ema-9-21", "hma-16", "tactic-trend-s"] as const

export const INVERSE_CONTINUATION_SOURCES = sourceIds.map(source=>{
  const baseId = `inverse-known-${source}`
  const base = PORTED_CATALOG.find(candidate=>candidate.id===baseId && candidate.kind==="inverse")
  if (!base) throw new Error(`Missing Inverse continuation source ${baseId}`)
  return {id:`inverse-follow-${source}`,baseId,kind:"inverse" as const,label:base.label.replace("opposite state","continuation")}
})

const byId = new Map(INVERSE_CONTINUATION_SOURCES.map(source=>[source.id,source.baseId]))
export const inverseContinuationBase = (id:string) => byId.get(id)
