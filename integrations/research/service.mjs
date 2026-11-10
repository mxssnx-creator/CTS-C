#!/usr/bin/env node
// Structured, read-only handoff from a fresh Node engine CSV export to research.
// No old CTS imports, account credentials, shell evaluation, or trade commands.
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, python: { type: 'string', default: 'python' },
  csv: { type: 'string' }, origin: { type: 'string' }, account: { type: 'string', default: 'x02' },
  'out-dir': { type: 'string', default: 'integrations/research/output' },
  'time-column': { type: 'string', default: 'timestamp' }, 'equity-column': { type: 'string', default: 'equity' },
} })
if (values.help || !values.csv || !values.origin) {
  console.log('Usage: node integrations/research/service.mjs --csv equity.csv --origin engine-vst [--python /path/to/research/python] [--account x02] [--out-dir path] [--time-column timestamp] [--equity-column equity]')
  process.exit(values.help ? 0 : 2)
}
if (!['engine-paper', 'engine-vst', 'engine-mainnet', 'imported-unverified', 'synthetic-fixture'].includes(values.origin)) {
  throw new Error('Invalid explicit ledger provenance')
}
const bridge = join(dirname(fileURLToPath(import.meta.url)), 'bridge.py')
const output = resolve(values['out-dir'])
await mkdir(output, { recursive: true })
const ledger = join(output, 'ledger-equity.json')
const report = join(output, 'equity-tearsheet.html')
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)))
const jobs = [
  ['ledger-csv', resolve(values.csv), '--time-column', values['time-column'], '--equity-column', values['equity-column'], '--origin', values.origin, '--account', values.account, '--out', ledger],
  ['report', ledger, '--out', report],
]
for (const args of jobs) {
  const child = spawnSync(values.python, [bridge, ...args], {
    shell: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...childEnvironment, MPLBACKEND: 'Agg' },
  })
  if (child.stdout) process.stdout.write(child.stdout)
  if (child.error || child.status !== 0) {
    if (child.stderr) process.stderr.write(child.stderr)
    if (child.error) process.stderr.write(`${child.error.message}\n`)
    process.exit(child.status || 2)
  }
}
console.log(JSON.stringify({ ok: true, source: resolve(values.csv), ledger, report, autoApplied: false, orderPlacement: false }))
