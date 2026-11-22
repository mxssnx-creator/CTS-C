import { PARABOLIC_SAR_VARIANTS, RSI_VARIANTS } from "./oscillator-sources"

export const SIGNAL_TIMEFRAMES = [1/6, 1, 5, 15, 30, 60] as const

const classicVariants = [
  ["trend-ema","EMA 9/21 trend"], ["ema-21-55","EMA 21/55 trend"], ["ema-pullback","EMA 21 pullback"],
  ["macd-cross","MACD 12/26/9 cross"], ["macd-cross-8-21-5","MACD 8/21/5 cross"], ["macd-hist-8-21-5","MACD 8/21/5 histogram"],
  ["bb-bounce","Bollinger 20/2 bounce"], ["bb-bounce-20-2.5","Bollinger 20/2.5 bounce"], ["bb-walk-50","Bollinger 50 band walk"],
  ["srsi-14-10","Stochastic RSI 14 · 10/90"],
  ["srsi-14-20","Stochastic RSI 14 · 20/80"], ["obv-20","OBV vs EMA 20"], ["obv-50","OBV vs EMA 50"],
  ["mfi-14-10","Money Flow Index 14 · 10/90"], ["mfi-14-20","Money Flow Index 14 · 20/80"],
] as const

/** Existing CTS-X RSI momentum and CTS-A-O quarter-hour candidates, exposed as independent sources. */
export const RESEARCH_TACTIC_SOURCES: readonly { id:string; label:string; kind:"tactic"; timeframes:readonly number[] }[] = [
  ...classicVariants.map(([id,label])=>({id,label,kind:"tactic" as const,timeframes:SIGNAL_TIMEFRAMES})),
  ...[...RSI_VARIANTS,...PARABOLIC_SAR_VARIANTS].map(({id,label})=>({id,label,kind:"tactic" as const,timeframes:SIGNAL_TIMEFRAMES})),
  {id:"r-qh-flow",kind:"tactic",label:"Quarter-hour order flow · short",timeframes:[1,5,15]},
  {id:"r-qh-flow-m",kind:"tactic",label:"Quarter-hour order flow · medium",timeframes:[1,5,15]},
  {id:"r-qh-rev",kind:"tactic",label:"Quarter-hour burst reversal · short",timeframes:[1,5,15]},
  {id:"r-qh-rev-m",kind:"tactic",label:"Quarter-hour burst reversal · medium",timeframes:[1,5,15]},
]

const framesById = new Map(RESEARCH_TACTIC_SOURCES.map(source => [source.id,source.timeframes]))
export const isResearchTacticSource = (id:string) => framesById.has(id)
export const supportsTacticTimeframe = (id:string,minutes:number) => framesById.get(id)?.includes(minutes) ?? minutes <= 30
