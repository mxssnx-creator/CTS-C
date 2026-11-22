export const CORE_INDICATIONS = ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"] as const
export const TECHNICAL_INDICATIONS = ["Trend","Trend_ADX","Trend_Efficiency","Trend_Fade","Break","Break_ATR","Break_Volume","Break_Retest","Break_Reversal"] as const
export const LEGACY_INDICATIONS = [...CORE_INDICATIONS,"MA_Inverse","Trend_Pullback","RSI_Momentum","Bollinger_Breakout",...TECHNICAL_INDICATIONS,"Tactic","Inverse"] as const
export const INDICATIONS = [...LEGACY_INDICATIONS,"Signals","Low-Range"] as const

export const CORE_SIGNAL_PERIODS = [0,5,8,10,14,20,30,40,60] as const
const commonTypes = new Set<string>([...CORE_INDICATIONS,"MA_Inverse","Trend_Pullback","RSI_Momentum","Bollinger_Breakout"])
export function indicationPeriods(type:string,technical:readonly number[],common:readonly number[]):readonly number[] {
  if ((TECHNICAL_INDICATIONS as readonly string[]).includes(type)) return technical
  if (!commonTypes.has(type)) return [20]
  return [...new Set(common.map(period=>period || (type === "RSI_Band" ? 14 : 20)))]
}
