import { NextResponse } from 'next/server'
import { getStore } from '@/core/store'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export function GET() {
  try { getStore().database.prepare('SELECT 1').get(); return NextResponse.json({ready:true,application:'CTS-C',version:'1.0.0'}) }
  catch {return NextResponse.json({ready:false},{status:503})}
}
