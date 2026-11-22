/** Compare stage evidence scopes or Block policies on matched closed market bars. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { blockStepVerdict } from '../core/block-auto.ts'
import { DEFAULT_ENGINE_SETTINGS, TradingEngine } from '../core/engine.ts'
import { describeProfitFactor } from '../core/metrics.ts'
import { SYSTEM_VOLUME_DIVISOR } from '../shared/cts-volume/ratios.ts'
import type { Candle, ClosedTrade, EngineSettings } from '../core/types.ts'
const symbols=['BTC-USDT','ETH-USDT','SOL-USDT','BCH-USDT','ADA-USDT','AVAX-USDT','BNB-USDT','LINK-USDT']
const [feedPath, outputPath, ...options] = process.argv.slice(2)
if (!feedPath || !outputPath) throw new Error('Usage: replay-config-stage-windows.ts FEED_JSON OUTPUT_JSON [--block-auto] [UTC decisions]')
const blockStudy = options.includes('--block-auto')
const dates = options.filter(option => option !== '--block-auto')
const bytes = readFileSync(feedPath), feed = JSON.parse(bytes.toString()).candles
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex')
const hourly=3_600_000
const scopeScenarios = {
  context: {stageWindowScope:'context'},
  config: {stageWindowScope:'config'},
  mixed: {stageWindowScope:'config',microStageWindowScope:'both'},
} as const satisfies Record<string,Partial<EngineSettings>>
const blockPolicies: Record<string, Partial<EngineSettings>> = {}
if (blockStudy) {
  const common = DEFAULT_ENGINE_SETTINGS.coordinations
  const policies = {
    'pyramid-shared': { ...common.block, behavior: 'pyramid', mode: 'shared' },
    'pyramid-additive': { ...common.block, behavior: 'pyramid', mode: 'additive' },
    'rounds-3': { ...common.block, behavior: 'rounds', size: 3, maxMultiplier: 1.4 },
    'rounds-6': { ...common.block, behavior: 'rounds', size: 6, maxMultiplier: 1.4 },
  } as const
  for (const [name, block] of Object.entries(policies)) {
    blockPolicies[name + '-manual'] = { stageWindowScope: 'config', coordinations: { ...common, block } }
    blockPolicies[name + '-auto'] = { stageWindowScope: 'config', coordinations: {
      ...common, block: { ...block, auto: { enabled: true, lastN: 12, minSamples: 3, minPF: 1.1 } },
    } }
  }
}
const scenarios = blockStudy ? blockPolicies : scopeScenarios
function stats(rows:ClosedTrade[]) {
  let gp=0, gl=0, cashGain=0, cashLoss=0, pnl=0, peak=0, drawdown=0
  const clock=new Map<number,number>()
  for(const row of rows){
    gp+=Math.max(0,row.netReturnPct);gl+=Math.max(0,-row.netReturnPct)
    cashGain+=Math.max(0,row.netPnl);cashLoss+=Math.max(0,-row.netPnl)
    clock.set(row.closedAt,(clock.get(row.closedAt)??0)+row.netPnl)
  }
  for(const value of clock.values()){pnl+=value;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl)}
  const pf=describeProfitFactor(gp,gl,rows.length), cash=describeProfitFactor(cashGain,cashLoss,rows.length)
  return {closed:rows.length,pf:pf.pfState==='finite'?pf.profitFactor:null,pfState:pf.pfState,
    cashPf:cash.pfState==='finite'?cash.profitFactor:null,cashPfState:cash.pfState,net:pnl,settledDrawdown:drawdown,
    added:rows.reduce((sum,row)=>sum+row.fills.length-1,0)}
}
const results=[]
for(const date of (dates.length?dates:['2026-10-09','2026-10-13','2026-10-17T09:00'])) {
  const start=Date.parse(date.includes('T')?date+'Z':date+'T00:00Z')
  function range(lo:number,hi:number):Record<string,Candle[]> {
    return Object.fromEntries(symbols.map(symbol=>{
      const bars=feed[symbol+'|1'].filter((row:{t:number})=>row.t>=lo&&row.t<hi)
      if(bars.length!==720||bars.some((row:{t:number},i:number)=>row.t!==lo+i*60_000))throw Error(`Noncontiguous data ${date} ${symbol}`)
      return [symbol,bars.map((r:{t:number;o:number;h:number;l:number;c:number;v:number})=>({timestamp:r.t,open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v}))]
    }))
  }
  const pre=range(start-12*hourly,start), forward=range(start,start+12*hourly)
  let coordinationControl: string | undefined
  for(const [scenario, scope] of Object.entries(scenarios)) {
    const engine=new TradingEngine({symbols,stageGateMode:'processed-sets', ...scope,
      stageLastN:{base:20,main:8,real:8},stageMinPF:{base:1.1,main:1.1,real:1.1},
      catalog:{strategyIndicationTypes:['Trend','Break','Signals','Tactic','Inverse'],strategyEnabledRanges:blockStudy?['Short','Normal']:['Micro','Low-Range','Minimal','Short','Normal','Long'],
        strategyTpSteps:blockStudy?[8,12,18]:[2,3,5,8,12,18],strategySlRatios:[.6,1],strategyExitModes:['fixed','trailing'],strategySignalTimeframes:[1],strategySignalPeriods:[20],
        strategySignalsSources:['sig-ema-cross-s'],strategyIndicationSources:['tactic-dca-bounce-8-percent-0.5-1-0.25','inverse-known-ema-9-21'],
        autoPfEnabled:true,autoPfRatio:.2,autoPfMax:2,makerFeePct:.02,takerFeePct:.05,slippagePctOfFees:10}})
    const began=performance.now()
    engine.processMarketCandles(pre)
    const before=engine.snapshot({laneLimit:0,positionLimit:0}), beforeState=engine.exportState()
    const trades:ClosedTrade[]=[]
    engine.observeLiveCloses(trade=>{if(trade.openedAt>=start)trades.push(trade)})
    engine.processMarketCandles(forward)
    const after=engine.snapshot({laneLimit:0,positionLimit:0}), afterState=engine.exportState()
    if(engine.pendingIntents().length)throw Error('Offline replay created venue intents')
    const lanes=Object.values(afterState.lanes), live=lanes.filter(l=>l.stage==='live'&&!l.calculationOnly)
    const grouped=Object.fromEntries(['normal','axis','block','dca'].map(coord=>{
      const own=live.filter(l=>l.coordination===coord)
      return [coord,{opened:own.reduce((n,l)=>n+l.admissionCount-(beforeState.lanes[l.id]?.admissionCount??0),0),
        held:own.filter(l=>l.open&&l.open.openedAt>=start).length,...stats(trades.filter(t=>t.coordination===coord))}]
    }))
    if (blockStudy) {
      const control = JSON.stringify([grouped.normal, grouped.axis, grouped.dca])
      if (coordinationControl !== undefined && control !== coordinationControl) {
        throw new Error(`Block policy moved another coordination on ${date} (${scenario})`)
      }
      coordinationControl = control
    }
    const settings = engine.settings
    const block = settings.coordinations.block
    const baseBudget = settings.baseNotional * (settings.volumeFactor / SYSTEM_VOLUME_DIVISOR)
    const blockRows = trades.filter(row => row.coordination === 'block')
    const blockDetails = blockStudy ? {
      raised: blockRows.filter(row => row.notional > baseBudget * (1 + 1e-9)).length,
      addedPositions: blockRows.filter(row => row.fills.length > 1).length,
      byCount: block.auto ? Array.from({ length: block.steps }, (_, index) => {
        const counts = { warming: 0, unknown: 0, held: 0, qualified: 0, samples: 0 }
        for (const lane of lanes) {
          if (lane.coordination !== 'block' || lane.stage !== 'real') continue
          const verdict = blockStepVerdict(lane, index + 1, block.auto!)
          counts[verdict.state]++
          counts.samples += verdict.samples
        }
        return { count: index + 1, ...counts }
      }) : [],
      hourly: Array.from({ length: 12 }, (_, hour) => ({
        start: start + hour * hourly,
        ...stats(blockRows.filter(row => row.closedAt >= start + hour * hourly && row.closedAt < start + (hour + 1) * hourly)),
      })),
    } : undefined
    const entry= {date,scenario,symbols,elapsedMs:Math.round(performance.now()-began),settings,
      before:before.stages, after:after.stages,live:stats(trades),grouped,blockDetails,
      byRange:Object.fromEntries([...new Set(live.map(l=>l.config.range))].map(range=>[range,stats(trades.filter(t=>afterState.lanes[t.laneId].config.range===range))])),
      byIndication:Object.fromEntries([...new Set(live.map(l=>l.config.type))].map(type=>[type,stats(trades.filter(t=>afterState.lanes[t.laneId].config.type===type))]))}
    results.push(entry)
    console.log(JSON.stringify({date,scenario,elapsedMs:entry.elapsedMs,configs:after.catalogCount,
      base:[before.stages[0].currentQualified,before.stages[0].currentLanes,before.stages[0].validatedWindow],live:entry.live,grouped}))
    writeFileSync(outputPath, JSON.stringify({fixtureSha256, preHours:12, tradeHours:12, ordersSubmitted:0, results}, null, 2) + '\n')
  }
}
