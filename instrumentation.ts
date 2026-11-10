export async function register(){
  if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NEXT_PHASE!=='phase-production-build'){
    const {getRuntime,shutdownRuntimes}=await import('./core/runtime')
    const {CONNECTIONS}=await import('./core/connections')
    for(const connection of CONNECTIONS)getRuntime(connection.id).resume()
    const shared=globalThis as typeof globalThis&{__ctscShutdownRegistered?:boolean}
    if(!shared.__ctscShutdownRegistered){shared.__ctscShutdownRegistered=true;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>shutdownRuntimes())}
  }
}
