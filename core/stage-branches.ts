import { checkExecWindows, checkLastNGrid, EXEC_EVALUATION_STAGES, execBlockPolicy, LAST_N_STAGES, POSITIVE_EXEC_OUTCOME, type EvaluationStage, type ExecWindows, type LastNGrid, type LegacyEvaluationStage } from "./last-n-grid"
import { blockRequired, type BlockPolicy, type Polarity } from "../shared/cts-lastn/blocks.ts"
import type { Coordination, StrategyConfig } from "./types"
import { EXEC_PROFILES, PROFILE_BASE_COORDINATIONS, PROFILE_CHILD_COORDINATIONS } from "./exec-profile"

type ChildStage = Exclude<EvaluationStage, "base">
export type StageCoordinations = Partial<Record<ChildStage, readonly Coordination[]>>
export const BRANCH_COORDINATIONS = ["normal", "axis", "block", "dca", "relate"] as const
export function checkStageCoordinations(raw: unknown): StageCoordinations {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new Error("Stage coordinations must be a stage map")
  }
  for (const [stage, choices] of Object.entries(raw)) {
    if (!["main", "real", "exec"].includes(stage) || !Array.isArray(choices) || new Set(choices).size !== choices.length ||
        choices.some(c => !BRANCH_COORDINATIONS.includes(c))) throw new Error("Invalid stage coordinations")
  }
  return raw as StageCoordinations
}

function baseRequirements(windows: ExecWindows | undefined): number[] {
  if (!windows) return []
  const {base} = windows
  return base.long.flatMap(long=>base.short.flatMap(short=>(base.shortOutcomes??POSITIVE_EXEC_OUTCOME)
    .flatMap(()=>base.last.flatMap(last=>(base.lastOutcomes??POSITIVE_EXEC_OUTCOME).map(()=>long+short+last))))).sort((a,b)=>a-b)
}
const profiles=new Map(EXEC_PROFILES.map(profile=>[profile.id,{windows:profile.windows,required:baseRequirements(profile.windows)}]))

/** Geometry is immutable. Only prefixes requested by an admitted parent get a configuration. */
export class ParentBranches {
  private readonly grid: LastNGrid
  private readonly windows?: ExecWindows
  readonly evaluationStages: readonly EvaluationStage[]
  private readonly commonBaseSampleCounts: readonly number[]
  readonly coordinations: StageCoordinations
  private readonly configs = new Map<string, StrategyConfig>()
  private readonly children = new Map<string, StrategyConfig[]>()
  private readonly policies = new Map<string, BlockPolicy>()

  constructor(catalog: Record<string, unknown>, readonly exec = false) {
    this.grid = checkLastNGrid(catalog.strategyLastNGrid)
    this.windows = exec ? checkExecWindows(catalog.strategyExecWindows) : undefined
    this.commonBaseSampleCounts = baseRequirements(this.windows)
    this.evaluationStages = exec ? EXEC_EVALUATION_STAGES : LAST_N_STAGES
    this.coordinations = checkStageCoordinations(catalog.strategyStageCoordinations)
  }

  baseSampleCounts(config: StrategyConfig): readonly number[] {
    return config.execProfile ? profiles.get(config.execProfile)!.required : this.commonBaseSampleCounts
  }

  private policy(long: number, short: number, last: number, shortOutcome:Polarity,lastOutcome:Polarity): BlockPolicy {
    const key = `${long}/${short}/${last}/${shortOutcome}/${lastOutcome}`
    let policy = this.policies.get(key)
    if (!policy) {
      policy = Object.freeze(execBlockPolicy(long, short, last,shortOutcome,lastOutcome))
      this.policies.set(key, policy)
    }
    return policy
  }

  private make(parent: StrategyConfig, coordination: Coordination | undefined, stage: EvaluationStage, n?: number, policy?: BlockPolicy) {
    const suffix = policy ? `${policy.long}-${policy.short}-${policy.minimal}${policy.shortPolarity==="negative"?"-sn":""}${policy.minimalPolarity==="negative"?"-ln":""}` : n ?? 0
    const id = parent.id + (coordination ? "." + coordination : policy ? ".branch2" : ".branch1") + "." + stage + suffix
    let config = this.configs.get(id)
    if (!config) {
      const ancestors = parent.branch?.ancestors ?? []
      const branch = { geometryId: parent.branch?.geometryId ?? parent.id,
        ancestors: coordination ? [...ancestors, { configId: parent.id, coordination }] : [],
        ...(policy && { windows: { ...parent.branch?.windows, [stage]: policy } }) }
      config = { ...parent, id, branch, stageLastN: n === undefined ? parent.stageLastN : { ...parent.stageLastN, [stage]: n } }
      this.configs.set(id, config)
    }
    return config
  }

  variants(parent: StrategyConfig, coordination: Coordination | undefined, stage: EvaluationStage): readonly StrategyConfig[] {
    const key = parent.id + "/" + (coordination ?? "") + "/" + stage
    let configs = this.children.get(key)
    if (!configs) {
      const plan = parent.execProfile ? profiles.get(parent.execProfile)!.windows : this.windows
      if (plan) {
        const windows = plan[stage]
        const longs = stage === "base" ? plan.base.long : plan[stage].long.map(mode => mode === "none" ? 0 : parent.branch!.windows!.base!.long)
        configs = []
        for (const long of longs) for (const s of windows.short) for (const l of windows.last) {
          for (const shortOutcome of windows.shortOutcomes??POSITIVE_EXEC_OUTCOME) for (const lastOutcome of windows.lastOutcomes??POSITIVE_EXEC_OUTCOME) {
            configs.push(this.make(parent, coordination, stage, undefined, this.policy(long,s,l,shortOutcome,lastOutcome)))
          }
        }
        if (stage === "base") configs.sort((a,b) => blockRequired(a.branch!.windows!.base!)-blockRequired(b.branch!.windows!.base!))
      } else {
        const options = this.grid[stage as LegacyEvaluationStage]
        configs = (options?.length ? options : [undefined]).map(n => this.make(parent, coordination, stage, n))
      }
      this.children.set(key, configs)
    }
    return configs
  }

  choices(stage: ChildStage, previous: Coordination, config?: StrategyConfig): readonly Coordination[] {
    if (config?.execProfile) return PROFILE_CHILD_COORDINATIONS
    const choices = this.coordinations[stage]
    if (choices?.length) return choices
    return this.exec ? BRANCH_COORDINATIONS : [previous]
  }

  get(id: string) { return this.configs.get(id) }

  /** Rebuild one saved path from current settings without enumerating its siblings. */
  restore(saved: StrategyConfig, geometry: StrategyConfig | undefined, enabled: (c: Coordination) => boolean): StrategyConfig | undefined {
    const branch = saved.branch
    if (!geometry || !branch || branch.geometryId !== geometry.id || !Array.isArray(branch.ancestors) ||
        branch.ancestors.length >= this.evaluationStages.length || Boolean(branch.windows) !== this.exec) return
    const plan = geometry.execProfile ? profiles.get(geometry.execProfile)!.windows : this.windows
    let parent = geometry
    for (let index = 0; index <= branch.ancestors.length; index++) {
      const stage = this.evaluationStages[index]
      const previous = branch.ancestors[index - 1], before = branch.ancestors[index - 2]
      if (previous && (previous.configId !== parent.id || !enabled(previous.coordination) ||
          (before ? !this.choices(this.evaluationStages[index - 1] as ChildStage,before.coordination,geometry).includes(previous.coordination)
            : geometry.execProfile && !PROFILE_BASE_COORDINATIONS.includes(previous.coordination)))) return
      if (plan) {
        const policy = branch.windows?.[stage], windows = plan[stage]
        if (!policy || !windows.short.includes(policy.short) || !windows.last.includes(policy.minimal) ||
            !(windows.shortOutcomes??POSITIVE_EXEC_OUTCOME).includes(policy.shortPolarity) || !(windows.lastOutcomes??POSITIVE_EXEC_OUTCOME).includes(policy.minimalPolarity)) return
        const allowedLong = stage === "base" ? plan.base.long.includes(policy.long)
          : policy.long === 0 ? plan[stage].long.includes("none")
          : policy.long === parent.branch!.windows!.base!.long && plan[stage].long.includes("inherit")
        if (!allowedLong) return
        parent = this.make(parent, previous?.coordination, stage, undefined, this.policy(policy.long,policy.short,policy.minimal,policy.shortPolarity,policy.minimalPolarity))
      } else {
        const legacy = stage as LegacyEvaluationStage, options = this.grid[legacy], n = saved.stageLastN?.[legacy]
        if (options?.length ? n === undefined || !options.includes(n) : n !== undefined) return
        parent = this.make(parent, previous?.coordination, stage, n)
      }
    }
    return parent.id === saved.id ? parent : undefined
  }
}
