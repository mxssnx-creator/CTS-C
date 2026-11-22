import type { LaneState } from "./types"

export type WindowEvidence = Pick<LaneState, "config" | "samples" | "closedCount" | "sampleTimes"> & { timedSampleCount?: number }
interface Row { at: number; laneId: string; value: number }
interface Group {
  lanes: LaneState[]
  latest: number
  unknownClock: boolean
  memo?: { before: number; limit: number; value: WindowEvidence }
}

/** Only current lanes with identical config, coordination, policy and source stage are members. */
export class ConfigStageWindows {
  private groups = new Map<string, Group>()
  private membership = new WeakMap<LaneState, Group>()

  add(lane: LaneState, key: string): void {
    if (this.membership.has(lane)) return
    let group = this.groups.get(key)
    if (!group) {
      group = { lanes: [], latest: 0, unknownClock: false }
      this.groups.set(key, group)
    }
    group.lanes.push(lane)
    this.membership.set(lane, group)
    const times = lane.sampleTimes ?? []
    const badClock = times.length > lane.samples.length || times.some((time, i) =>
      !Number.isFinite(time) || time <= 0 || (i > 0 && time > times[i - 1]))
    group.unknownClock ||= badClock
    this.settled(lane, times[0] ?? 0)
  }

  settled(lane: LaneState, at: number): void {
    const group = this.membership.get(lane)
    if (group) {
      group.latest = Math.max(group.latest, at)
      group.memo = undefined
    }
  }

  evidence(lane: LaneState, before: number, limit: number): WindowEvidence | undefined {
    const group = this.membership.get(lane)
    if (!group) return
    const cutoff = before > group.latest ? Infinity : before
    if (group.memo?.before === cutoff && group.memo.limit === limit) return group.memo.value
    let rows: Row[] = []
    if (!group.unknownClock) for (const member of group.lanes) {
      const times = member.sampleTimes
      if (!times?.length) continue
      // Each exact lane is sorted newest-first. Exclude settlements at the
      // decision clock, including on another symbol processed first.
      let from = times.findIndex(time => time < cutoff)
      if (from < 0) continue
      if (rows.length === limit && times[from] < rows[limit - 1].at) continue
      const merged: Row[] = []
      let i = 0
      while (merged.length < limit && (i < rows.length || from < times.length)) {
        const prior = rows[i], at = times[from]
        if (prior && (from === times.length || prior.at > at || (prior.at === at && prior.laneId < member.id))) {
          merged.push(prior)
          i++
        } else {
          merged.push({at, laneId: member.id, value: member.samples[from]})
          from++
        }
      }
      rows = merged
    }
    const samples = group.unknownClock ? [NaN] : rows.map(row => row.value)
    const value = {config: lane.config, samples, closedCount: samples.length}
    group.memo = {before: cutoff, limit, value}
    return value
  }
}
