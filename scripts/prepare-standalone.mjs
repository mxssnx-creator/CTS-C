import { cp, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
// Runtime journals and environment files must never become deployment assets.
async function assertCleanArtifact(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const name=join(directory,entry.name)
    if(entry.name==='.data'||entry.name.startsWith('.env')||/\.sqlite(?:-|$)/.test(entry.name))throw new Error(`Private runtime file in standalone artifact: ${name}`)
    if(entry.isDirectory())await assertCleanArtifact(name)
  }
}
await assertCleanArtifact('.next/standalone')
await mkdir('.next/standalone/.next',{recursive:true})
await cp('.next/static','.next/standalone/.next/static',{recursive:true})
