import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve persistence before Next standalone changes its working directory.
for (const file of ['.env.local', '.env']) if (existsSync(file)) loadEnvFile(file)
process.env.CTS_DATA_DIR = resolve(process.env.CTS_DATA_DIR || '.data')
process.env.HOSTNAME = process.env.CTS_HOST || '127.0.0.1'
process.env.PORT ||= '3001'
await import(pathToFileURL(resolve('.next/standalone/server.js')).href)
