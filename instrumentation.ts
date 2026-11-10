export async function register(){
  if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NEXT_PHASE!=='phase-production-build'){
    const {getRuntime}=await import('./core/runtime')
    const runtime=getRuntime()
    runtime.resume()
    const shared=globalThis as typeof globalThis&{__ctscShutdownRegistered?:boolean}
    if(!shared.__ctscShutdownRegistered){shared.__ctscShutdownRegistered=true;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>runtime.shutdown())}
  }
}
