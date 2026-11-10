import { NextRequest,NextResponse } from 'next/server'
import { requireAdmin } from '@/core/auth'
import { getRuntime } from '@/core/runtime'
import { demoCredentials } from '@/core/bingx'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export function GET(request:NextRequest){const denied=requireAdmin(request);if(denied)return denied;try{return NextResponse.json(getRuntime().snapshot())}catch{return NextResponse.json({error:'Terminal state is unavailable'},{status:503})}}
export async function POST(request:NextRequest){
  const denied=requireAdmin(request);if(denied)return denied
  try{
    const body=await request.json(),runtime=getRuntime()
    return await runtime.serial(async()=>{
      if(body.action==='save-settings'){if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))return NextResponse.json({error:'Settings object required'},{status:400});runtime.saveFlatSettings(body.settings)}
      else if(body.action==='configure-x02'){if(!demoCredentials())return NextResponse.json({error:'Set BINGX_X02_KEY and BINGX_X02_SECRET on the server; mainnet credentials are not reused.'},{status:409})}
      else if(body.action==='start-x02')await runtime.start()
      else if(body.action==='pause-x02')runtime.pause()
      else return NextResponse.json({error:'Unknown action'},{status:400})
      return NextResponse.json({success:true})
    })
  }catch(error){
    if(error instanceof Error&&error.message==='Another CTS-C process owns this data directory')return NextResponse.json({error:'Another CTS-C process owns this data directory',code:'RUNTIME_OWNED'},{status:409})
    return NextResponse.json({error:error instanceof Error?error.message:'Action failed'},{status:400})
  }
}
