const rsiPeriods = [5,8,10,14,21] as const
const rsiLowerLevels = [15,20,25,30,35] as const
const importedRsiIds = new Set(["rsi-mom-10-25","rsi-mom-14-15","rsi-mom-14-20","rsi-mom-14-25","rsi-mom-21-15","rsi-mom-21-20","rsi-mom-21-25"])

export const RSI_VARIANTS = rsiPeriods.flatMap(period=>rsiLowerLevels.flatMap(lower=>(["reclaim","momentum"] as const).map(method=>{
  const id = `rsi-${method==="momentum"?"mom":method}-${period}-${lower}`
  return {id, period, lower, method, label:`RSI ${period} · ${lower}/${100-lower} · ${method}`, imported:importedRsiIds.has(id)}
})))

const sarSteps = [.005,.01,.02,.03,.04] as const
const sarCaps = [.10,.15,.20,.30] as const
export const PARABOLIC_SAR_VARIANTS = sarSteps.flatMap(step=>sarCaps.map(cap=>{
  const importedId = step===.02&&cap===.2 ? "sar-std" : step===.04&&cap===.3 ? "sar-fast" : undefined
  return {id:importedId??`parabolic-sar-${step}-${cap}`,step,cap,label:`Parabolic SAR · AF ${step} · max ${cap}`,imported:Boolean(importedId)}
}))

export const THIN_OSCILLATOR_SOURCE_IDS = [
  "rsi-reclaim-5-25", "rsi-reclaim-8-30", "rsi-reclaim-14-30", "rsi-mom-14-25",
  "parabolic-sar-0.005-0.1", "parabolic-sar-0.01-0.15", "sar-std", "sar-fast",
]
