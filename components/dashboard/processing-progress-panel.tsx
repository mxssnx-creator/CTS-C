'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, BarChart3, TrendingUp, Zap } from 'lucide-react'
import type { ProcessingMetrics } from '@/lib/processing-metrics'

interface ProcessingProgressPanelProps {
  connectionId?: string
}

export function ProcessingProgressPanel({ connectionId }: ProcessingProgressPanelProps) {
  const [metrics, setMetrics] = useState<ProcessingMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectionId || connectionId === 'demo-mode') {
      setLoading(false)
      return
    }

    const fetchMetrics = async () => {
      try {
        const response = await fetch(`/api/metrics/processing?connectionId=${encodeURIComponent(connectionId)}`)
        if (!response.ok) {
          throw new Error('Failed to fetch metrics')
        }
        const data = await response.json()
        if (data.success) {
          setMetrics(data.data.current)
          setError(null)
        } else {
          setError(data.error)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchMetrics()
    const interval = setInterval(fetchMetrics, 5000) // Refresh every 5 seconds

    return () => clearInterval(interval)
  }, [connectionId])

  if (loading) {
    return (
      <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">Processing Progress</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-slate-400">Loading...</CardContent>
      </Card>
    )
  }

  if (error || !metrics) {
    return (
      <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Processing Progress
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-xs text-slate-400">
            {error ? `Error: ${error}` : 'No processing data yet. Start the engine and enable a connection to see progress.'}
          </div>
          {['Prehistoric', 'Realtime', 'Indication', 'Strategy'].map((phase) => (
            <div key={phase} className="flex items-center justify-between p-2 rounded bg-slate-800/50">
              <span className="text-xs text-slate-400">{phase}</span>
              <Badge variant="outline" className="text-[10px] py-0 bg-slate-700 text-slate-400 border-slate-600">
                idle
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    )
  }

  const phases = [
    { key: 'prehistoric', label: 'Prehistoric', icon: Activity, color: 'bg-blue-500' },
    { key: 'realtime', label: 'Realtime', icon: TrendingUp, color: 'bg-green-500' },
    { key: 'indication', label: 'Indication', icon: Zap, color: 'bg-yellow-500' },
    { key: 'strategy', label: 'Strategy', icon: BarChart3, color: 'bg-purple-500' },
  ]

  return (
    <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Activity className="w-4 h-4" />
          Processing Progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {/* Phase Progress */}
        <div className="space-y-2">
          {phases.map(({ key, label, icon: Icon, color }) => {
            const phase = metrics.phases[key as keyof typeof metrics.phases]
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="w-3 h-3 text-slate-400" />
                    <span className="text-slate-300 font-medium">{label}</span>
                    <Badge
                      variant="outline"
                      className={`text-xs py-0 px-1 ${
                        phase.status === 'completed'
                          ? 'bg-green-900 text-green-200 border-green-700'
                          : phase.status === 'running'
                            ? 'bg-blue-900 text-blue-200 border-blue-700'
                            : phase.status === 'error'
                              ? 'bg-red-900 text-red-200 border-red-700'
                              : 'bg-slate-700 text-slate-300 border-slate-600'
                      }`}
                    >
                      {phase.status}
                    </Badge>
                  </div>
                  <span className="text-slate-400">{phase.cycleCount} cycles</span>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-slate-700 rounded h-1.5 overflow-hidden">
                  <div
                    className={`h-full ${color} transition-all duration-300`}
                    style={{ width: `${Math.min(phase.progress, 100)}%` }}
                  />
                </div>

                {/* Progress Text */}
                <div className="flex justify-between text-slate-500 text-xs">
                  <span>
                    {phase.itemsProcessed} / {phase.itemsTotal}
                  </span>
                  <span>{Math.round(phase.progress)}%</span>
                </div>

                {/* Timeframe */}
                {phase.status === 'running' && (
                  <div className="text-slate-400 text-xs">
                    Timeframe: {phase.currentTimeframe} | Duration: {(phase.duration / 1000).toFixed(1)}s
                  </div>
                )}

                {phase.errorMessage && (
                  <div className="text-red-400 text-xs mt-1">Error: {phase.errorMessage}</div>
                )}
              </div>
            )
          })}
        </div>

        {/* Performance Metrics */}
        <div className="pt-2 border-t border-slate-700 space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-400">Avg Cycle Duration:</span>
            <span className="text-slate-200 font-medium">{metrics.performanceMetrics.avgCycleDuration.toFixed(0)}ms</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Total Processing Time:</span>
            <span className="text-slate-200 font-medium">{(metrics.performanceMetrics.totalProcessingTime / 1000).toFixed(1)}s</span>
          </div>
        </div>

        {/* Position Metrics */}
        <div className="pt-2 border-t border-slate-700 space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-400">Positions Created:</span>
            <span className="text-slate-200 font-medium">{metrics.pseudoPositions.totalCreated}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Positions Active:</span>
            <span className="text-green-400 font-medium">{metrics.pseudoPositions.currentActive}</span>
          </div>
        </div>

        {/* Evaluation Counts */}
        <div className="pt-2 border-t border-slate-700 space-y-1">
          <div className="text-slate-400 font-medium mb-1">Evaluations</div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Indication Base:</span>
              <span className="text-slate-200">{metrics.evaluationCounts.indicationBase}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Indication Main:</span>
              <span className="text-slate-200">{metrics.evaluationCounts.indicationMain}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Strategy Base:</span>
              <span className="text-slate-200">{metrics.evaluationCounts.strategyBase}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Strategy Main:</span>
              <span className="text-slate-200">{metrics.evaluationCounts.strategyMain}</span>
            </div>
          </div>
        </div>

        {/* Last Updated */}
        <div className="pt-2 border-t border-slate-700 text-slate-500 text-xs">
          Last updated: {new Date(metrics.timestamp).toLocaleTimeString()}
        </div>
      </CardContent>
    </Card>
  )
}
