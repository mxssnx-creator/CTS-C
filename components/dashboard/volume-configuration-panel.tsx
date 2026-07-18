"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Volume2 } from "lucide-react"

interface VolumeConfigurationPanelProps {
  liveVolumeFactor: number
  presetVolumeFactor: number
  onLiveVolumeChange: (value: number) => void
  onPresetVolumeChange: (value: number) => void
  orderType: "market" | "limit"
  onOrderTypeChange: (type: "market" | "limit") => void
  volumeType: "usdt" | "contract"
  onVolumeTypeChange: (type: "usdt" | "contract") => void
  enginePhase?: string
  globalEngineRunning?: boolean
}

const PRESET_MULTIPLIERS = [0.5, 1.0, 1.5, 2.0]

export function VolumeConfigurationPanel({
  liveVolumeFactor,
  presetVolumeFactor,
  onLiveVolumeChange,
  onPresetVolumeChange,
  orderType,
  onOrderTypeChange,
  volumeType,
  onVolumeTypeChange,
  enginePhase,
  globalEngineRunning = false,
}: VolumeConfigurationPanelProps) {
  const [expandedSection, setExpandedSection] = useState<"live" | "preset" | "order" | null>(null)
  
  const slidersDisabled = !globalEngineRunning || enginePhase === "idle" || enginePhase === "stopped" || enginePhase === "error"

  return (
    <div className="space-y-4">
      {/* Volume Configuration Header */}
      <div className="flex items-center gap-2 px-1">
        <Volume2 className="h-4 w-4 text-blue-500" />
        <h3 className="text-sm font-semibold">Configuration</h3>
      </div>

      {/* Live Trade Volume Factor */}
      <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Live Trade Volume</Label>
          <Badge variant="secondary" className="text-xs">
            {liveVolumeFactor.toFixed(2)}x
          </Badge>
        </div>
        <Slider
          value={[liveVolumeFactor]}
          onValueChange={(value) => onLiveVolumeChange(value[0])}
          min={0.1}
          max={10}
          step={0.1}
          className="w-full"
          disabled={slidersDisabled}
        />
        <div className="flex gap-2 flex-wrap">
          {PRESET_MULTIPLIERS.map((mult) => (
            <Button
              key={mult}
              variant={liveVolumeFactor === mult ? "default" : "outline"}
              size="sm"
              className="text-xs"
              onClick={() => onLiveVolumeChange(mult)}
              disabled={slidersDisabled}
            >
              {mult}x
            </Button>
          ))}
        </div>
      </div>

      {/* Preset Trade Volume Factor */}
      <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Preset Trade Volume</Label>
          <Badge variant="secondary" className="text-xs">
            {presetVolumeFactor.toFixed(2)}x
          </Badge>
        </div>
        <Slider
          value={[presetVolumeFactor]}
          onValueChange={(value) => onPresetVolumeChange(value[0])}
          min={0.1}
          max={10}
          step={0.1}
          className="w-full"
          disabled={slidersDisabled}
        />
        <div className="flex gap-2 flex-wrap">
          {PRESET_MULTIPLIERS.map((mult) => (
            <Button
              key={mult}
              variant={presetVolumeFactor === mult ? "default" : "outline"}
              size="sm"
              className="text-xs"
              onClick={() => onPresetVolumeChange(mult)}
              disabled={slidersDisabled}
            >
              {mult}x
            </Button>
          ))}
        </div>
      </div>

      <Separator className="my-2" />

      {/* Order Settings */}
      <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs font-medium">Order Type</Label>
            <Select value={orderType} onValueChange={(value: any) => onOrderTypeChange(value)}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="market">Market</SelectItem>
                <SelectItem value="limit">Limit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">Volume Type</Label>
            <Select value={volumeType} onValueChange={(value: any) => onVolumeTypeChange(value)}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="usdt">USDT</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  )
}
