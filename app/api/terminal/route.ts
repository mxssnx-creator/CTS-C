import { NextRequest,NextResponse } from 'next/server'
import { requireAdmin } from '@/core/auth'
import { getRuntime } from '@/core/runtime'
import { connectionCredentials } from '@/core/bingx'
import {connectionInfo} from '@/core/connections'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export function GET(request:NextRequest){const denied=requireAdmin(request);if(denied)return denied;try{const connection=connectionInfo(request.nextUrl.searchParams.get('connection')??undefined);return NextResponse.json(getRuntime(connection.id).snapshot())}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Terminal state is unavailable'},{status:400})}}
export async function POST(request:NextRequest){
  const denied=requireAdmin(request);if(denied)return denied
  try{
    const body=await request.json(),connection=connectionInfo(body.connectionId??undefined),runtime=getRuntime(connection.id)
    return await runtime.serial(async()=>{
      if(body.action==='save-settings'){if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))return NextResponse.json({error:'Settings object required'},{status:400});runtime.saveFlatSettings(body.settings)}
      else if(body.action==='configure-connection'||body.action===`configure-${connection.name.toLowerCase()}`){if(!connectionCredentials(connection.id))return NextResponse.json({error:`Set dedicated ${connection.name} key and secret on the server; accounts never reuse credentials.`},{status:409})}
      else if(body.action==='start-connection'||body.action===`start-${connection.name.toLowerCase()}`)await runtime.start()
      else if(body.action==='pause-connection'||body.action===`pause-${connection.name.toLowerCase()}`)runtime.pause()
      else return NextResponse.json({error:'Unknown action'},{status:400})
      return NextResponse.json({success:true})
    })
  }catch(error){
    if(error instanceof Error&&error.message==='Another CTS-C process owns this data directory')return NextResponse.json({error:'Another CTS-C process owns this data directory',code:'RUNTIME_OWNED'},{status:409})
    return NextResponse.json({error:error instanceof Error?error.message:'Action failed'},{status:400})
  }
}
