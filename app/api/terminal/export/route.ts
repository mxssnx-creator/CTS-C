import { requireAdmin } from '@/core/auth'
import { getRuntime } from '@/core/runtime'
import {connectionInfo} from '@/core/connections'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export function GET(request:Request){const denied=requireAdmin(request);if(denied)return denied;try{const connection=connectionInfo(new URL(request.url).searchParams.get('connection')??undefined);const rows=getRuntime(connection.id).engine.snapshot({laneLimit:0,positionLimit:0}).equityHistory;const body='timestamp,equity,drawdownPct,source\n'+rows.map(r=>`${new Date(r.timestamp).toISOString()},${r.equity},${r.drawdownPct},engine-paper`).join('\n');return new Response(body,{headers:{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':`attachment; filename="cts-c-${connection.name.toLowerCase()}-paper-equity.csv"`}})}catch{return Response.json({error:'Invalid connection'},{status:400})}}
