import preset from "../research-data/exec-dca-trend-preset.json"
import type { Coordination, EngineSettings } from "./types"
import { checkExecWindows } from "./last-n-grid"

const signed = {short:[4],last:[1],shortOutcomes:["positive","negative"],lastOutcomes:["positive","negative"]}
const recoveryWindows = checkExecWindows({base:{...signed,long:[10,20]},main:{...signed,long:["none"]},
  real:{...signed,long:["none"]},exec:{...signed,long:["none"],short:[4,8,12]}})
const referenceWindows = checkExecWindows(preset.strategyExecWindows)

export const EXEC_PROFILES = [
  {id:"trend-dca-v1", setting:"strategyTrendDcaEnabled", label:"Trend + DCA", enabledByDefault:true, windows:referenceWindows, catalogs:[{}]},
  {id:"sar-dca-v1", setting:"strategySarDcaEnabled", label:"Parabolic SAR + DCA", enabledByDefault:true, windows:referenceWindows, catalogs:[{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["parabolic-sar-0.01-0.15","sar-fast"],
  }]},
  {id:"rsi-continuation-dca-v1", setting:"strategyRsiContinuationDcaEnabled", label:"RSI Momentum + DCA", enabledByDefault:true, windows:referenceWindows, catalogs:[{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["rsi-mom-8-35-follow"],
    strategyEnabledRanges:["Normal"], strategyTpSteps:[18],
  },{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["rsi-mom-5-35"],
    strategyEnabledRanges:["Minimal"], strategyTpSteps:[8],
  }]},
  {id:"breakout-continuation-dca-v1", setting:"strategyBreakoutContinuationDcaEnabled", label:"Breakout Continuation + DCA", enabledByDefault:true, windows:referenceWindows, catalogs:[{
    strategyIndicationTypes:["Break_Continuation"], strategySignalPeriods:[20], strategySlRatios:[.8],
  }]},
  {id:"trend-recovery-dca-v1", setting:"strategyTrendRecoveryDcaEnabled", label:"Trend Efficiency + DCA", enabledByDefault:true, windows:recoveryWindows, catalogs:[{
    strategyIndicationTypes:["Trend_Efficiency"], strategyEnabledRanges:["Minimal"], strategyTpSteps:[8], strategySlRatios:[.8],
  }]},
  {id:"breakout-recovery-dca-v1", setting:"strategyBreakoutRecoveryDcaEnabled", label:"Breakout Retest + DCA", enabledByDefault:true, windows:recoveryWindows, catalogs:[{
    strategyIndicationTypes:["Break_Retest"], strategySlRatios:[.8],
  }]},
  {id:"sar-af04-dca-v1", setting:"strategySar04DcaEnabled", label:"Parabolic SAR 0.04/0.10 + DCA", enabledByDefault:true, windows:referenceWindows, catalogs:[{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["parabolic-sar-0.04-0.1"], strategySlRatios:[.8],
  }]},
  {id:"inverse-recovery-dca-v1", setting:"strategyInverseRecoveryDcaEnabled", label:"Inverse RSI turn and SAR + DCA", enabledByDefault:false, windows:recoveryWindows, catalogs:[{
    strategyIndicationTypes:["Inverse"], strategyIndicationSources:["inverse-rsi2-turn-10","inverse-follow-sar-std"],
    strategyEnabledRanges:["Minimal","Low-Range"], strategyTpSteps:[7], strategySlRatios:[1.2],
  }]},
  {id:"activity-momentum-dca-v1", setting:"strategyActivityMomentumDcaEnabled", label:"Activity ATR Momentum + DCA", enabledByDefault:false, windows:recoveryWindows, catalogs:[{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["act-hf-8"],
    strategyEnabledRanges:["Minimal"], strategyTpSteps:[8], strategySlRatios:[.8],
  }]},
] as const
export type ExecProfile = typeof EXEC_PROFILES[number]
export const PROFILE_BASE_COORDINATIONS: readonly Coordination[] = ["normal", "dca"]
export const PROFILE_CHILD_COORDINATIONS: readonly Coordination[] = ["dca"]
export const PROFILE_DCA_SIZING: EngineSettings["coordinations"]["dca"] = Object.freeze({
  enabled:true, steps:preset.dcaSteps, distancePct:preset.dcaDistancePct, multiplier:preset.dcaMultiplier,
})

export function execProfileEnabled(settings: EngineSettings, profile: ExecProfile): boolean {
  return settings.stageGateMode === "exec-branches" && settings.catalog[profile.setting] === true && settings.coordinations.dca.enabled
}

/** Adopt the product default for old checkpoints without overriding a saved preference. */
export function withDefaultExecProfile(settings: EngineSettings): EngineSettings {
  const defaults = EXEC_PROFILES.filter(profile=>settings.catalog[profile.setting]===undefined)
  if (!defaults.length) return settings
  return {...settings,catalog:{...settings.catalog,...Object.fromEntries(defaults.map(profile=>[profile.setting,profile.enabledByDefault]))}}
}
