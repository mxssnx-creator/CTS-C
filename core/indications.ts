export const CORE_INDICATIONS = ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"] as const
export const TECHNICAL_INDICATIONS = ["Trend","Trend_ADX","Trend_Efficiency","Trend_Fade","Break","Break_ATR","Break_Volume","Break_Retest","Break_Reversal"] as const
export const INDICATIONS = [...CORE_INDICATIONS,"MA_Inverse","Trend_Pullback","RSI_Momentum","Bollinger_Breakout",...TECHNICAL_INDICATIONS,"Tactic","Inverse"] as const
