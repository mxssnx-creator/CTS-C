import preset from "../research-data/exec-dca-trend-preset.json"
import type { Coordination, EngineSettings } from "./types"

export const EXEC_PROFILES = [
  {id:"trend-dca-v1", setting:"strategyTrendDcaEnabled", label:"Trend + DCA", catalog:{}},
  {id:"sar-dca-v1", setting:"strategySarDcaEnabled", label:"Parabolic SAR + DCA", catalog:{
    strategyIndicationTypes:["Tactic"], strategyIndicationSources:["parabolic-sar-0.01-0.15","sar-fast"],
  }},
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
  return {...settings,catalog:{...settings.catalog,...Object.fromEntries(defaults.map(profile=>[profile.setting,true]))}}
}
