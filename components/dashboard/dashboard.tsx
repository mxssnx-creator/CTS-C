"use client"

import React, { type ReactNode } from "react"
import { PageHeader } from "@/components/page-header"
import { QuickstartSection } from "./quickstart-section"
import { SystemOverview } from "./system-overview"
import { GlobalTradeEngineControls } from "./global-trade-engine-controls"
import { DashboardActiveConnectionsManager } from "./dashboard-active-connections-manager"
import { StatisticsOverviewV2 } from "./statistics-overview-v2"
import { SystemMonitoringPanel } from "./system-monitoring-panel"
import { EngineProgressionTestButton } from "./engine-progression-test-dialog"
import { DetailedLogsButton } from "./detailed-logs-button"
import { Card } from "@/components/ui/card"
import { useIndicationGenerator } from "@/components/indication-generator-hook"

interface ErrorBoundaryProps { children: ReactNode; name: string }
interface ErrorBoundaryState { hasError: boolean; error?: Error }

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error) {
    console.error(`[Dashboard] Error in ${this.props.name}:`, error)
  }
  render() {
    if (this.state.hasError) {
      return (
        <Card className="p-4 border-destructive/50 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Failed to load: {this.props.name}</p>
          <p className="text-xs text-muted-foreground mt-1">{this.state.error?.message}</p>
        </Card>
      )
    }
    return this.props.children
  }
}

export function Dashboard() {
  // Auto-generate indications every 3 seconds using the simple generator
  // This bypasses the stale webpack bundle issue with IndicationProcessor
  useIndicationGenerator(true, 3000)
  
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        title="CTS v3.2 Dashboard"
        description="Monitor and control your active exchange connections"
        showExchangeSelector
      >
        {/*
         * Top-level "Run Engine Test" button — mirrors the same dialog that
         * the QuickstartSection hosts, but rendered in the page header so
         * operators can trigger a full 7-phase engine progression test
         * without scrolling. `variant="header"` renders the slightly larger
         * primary-accent pill used for header actions.
        */}
        <DetailedLogsButton />
        <EngineProgressionTestButton variant="header" />
      </PageHeader>

      <div className="flex-1 space-y-4 px-3 md:px-4 py-4 pb-8">
        <ErrorBoundary name="Quickstart">
          <QuickstartSection />
        </ErrorBoundary>

        <ErrorBoundary name="System Overview">
          <SystemOverview />
        </ErrorBoundary>

        <ErrorBoundary name="Trade Engine Controls">
          <GlobalTradeEngineControls />
        </ErrorBoundary>

        <ErrorBoundary name="Active Connections">
          <DashboardActiveConnectionsManager />
        </ErrorBoundary>

        <ErrorBoundary name="Statistics">
          <StatisticsOverviewV2 />
        </ErrorBoundary>

        <ErrorBoundary name="System Monitoring">
          <SystemMonitoringPanel />
        </ErrorBoundary>
      </div>
    </div>
  )
}
