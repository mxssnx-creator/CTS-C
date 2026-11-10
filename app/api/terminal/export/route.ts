import { requireAdmin } from '@/core/auth'
import { getRuntime } from '@/core/runtime'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export function GET(request:Request){const denied=requireAdmin(request);if(denied)return denied;const rows=getRuntime().engine.snapshot({laneLimit:0,positionLimit:0}).equityHistory;const body='timestamp,equity,drawdownPct,source\n'+rows.map(r=>`${new Date(r.timestamp).toISOString()},${r.equity},${r.drawdownPct},engine-paper`).join('\n');return new Response(body,{headers:{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="cts-c-paper-equity.csv"'}})}
