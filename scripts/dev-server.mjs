// Normalize the two common dev-server host option spellings. The managed
// preview runner supplies --host; Next.js calls the same option --hostname.
import { spawn } from 'node:child_process'
const input=process.argv.slice(2), args=[]
for(let i=0;i<input.length;i++) {
  if(input[i]==='--strictPort') continue
  args.push(input[i]==='--host'?'--hostname':input[i])
}
if(!args.includes('--hostname'))args.push('--hostname','127.0.0.1')
if(!args.includes('--port')&&!args.includes('-p'))args.push('--port','3001')
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev',...args],{stdio:'inherit',env:process.env})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>process.exit(code??1))
