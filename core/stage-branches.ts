import { checkLastNGrid, LAST_N_STAGES, type EvaluationStage, type LastNGrid } from "./last-n-grid"
import type { Coordination, StrategyConfig } from "./types"

export type StageCoordinations = Partial<Record<"main" | "real", readonly Coordination[]>>
export const BRANCH_COORDINATIONS = ["normal", "axis", "block", "dca", "relate"] as const
export function checkStageCoordinations(raw: unknown): StageCoordinations {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new Error("Stage coordinations must be a stage map")
  }
  for (const [stage, choices] of Object.entries(raw)) {
    if (!["main", "real"].includes(stage) || !Array.isArray(choices) || new Set(choices).size !== choices.length ||
        choices.some(c => !BRANCH_COORDINATIONS.includes(c))) throw new Error("Invalid stage coordinations")
  }
  return raw as StageCoordinations
}

/** Geometry is immutable. Only prefixes requested by an admitted parent get a configuration. */
export class ParentBranches {
  private readonly grid: LastNGrid
  readonly coordinations: StageCoordinations
  private readonly configs = new Map<string, StrategyConfig>()
  private readonly children = new Map<string, StrategyConfig[]>()

  constructor(catalog: Record<string, unknown>) {
    this.grid = checkLastNGrid(catalog.strategyLastNGrid)
    this.coordinations = checkStageCoordinations(catalog.strategyStageCoordinations)
  }

  private make(parent: StrategyConfig, coordination: Coordination | undefined, stage: EvaluationStage, n: number | undefined) {
    const id = parent.id + (coordination ? "." + coordination : ".branch1") + "." + stage + (n ?? 0)
    let config = this.configs.get(id)
    if (!config) {
      const ancestors = parent.branch?.ancestors ?? []
      const branch = { geometryId: parent.branch?.geometryId ?? parent.id,
        ancestors: coordination ? [...ancestors, { configId: parent.id, coordination }] : [] }
      config = { ...parent, id, branch, stageLastN: n === undefined ? parent.stageLastN : { ...parent.stageLastN, [stage]: n } }
      this.configs.set(id, config)
    }
    return config
  }

  variants(parent: StrategyConfig, coordination: Coordination | undefined, stage: EvaluationStage): readonly StrategyConfig[] {
    const key = parent.id + "/" + (coordination ?? "") + "/" + stage
    let configs = this.children.get(key)
    if (!configs) {
      const options = this.grid[stage]
      configs = (options?.length ? options : [undefined]).map(n => this.make(parent, coordination, stage, n))
      this.children.set(key, configs)
    }
    return configs
  }

  choices(stage: "main" | "real", previous: Coordination): readonly Coordination[] {
    const choices = this.coordinations[stage]
    return choices?.length ? choices : [previous]
  }

  get(id: string) { return this.configs.get(id) }

  /** Rebuild one saved path from current settings without enumerating its siblings. */
  restore(saved: StrategyConfig, geometry: StrategyConfig | undefined, enabled: (c: Coordination) => boolean): StrategyConfig | undefined {
    const branch = saved.branch
    if (!geometry || !branch || branch.geometryId !== geometry.id || !Array.isArray(branch.ancestors) || branch.ancestors.length > 2) return
    let parent = geometry
    for (let index = 0; index <= branch.ancestors.length; index++) {
      const stage = LAST_N_STAGES[index], options = this.grid[stage], n = saved.stageLastN?.[stage]
      if (options?.length ? n === undefined || !options.includes(n) : n !== undefined) return
      const previous = branch.ancestors[index - 1], before = branch.ancestors[index - 2]
      if (previous && (previous.configId !== parent.id || !enabled(previous.coordination) ||
          before && !this.choices("main", before.coordination).includes(previous.coordination))) return
      parent = this.make(parent, previous?.coordination, stage, n)
    }
    return parent.id === saved.id ? parent : undefined
  }
}
