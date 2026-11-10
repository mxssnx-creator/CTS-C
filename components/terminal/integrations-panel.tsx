"use client"

import { useState } from "react"
import { Check, Copy, Download, ExternalLink, FlaskConical, Search, Workflow } from "lucide-react"
import registry from "@/integrations/research/registry.json"

const prerequisites: Record<string, string> = {
  "research-indicators": "Run market-fetch first to populate /reports/btc-vst.json.",
  "research-backtest": "Run market-fetch first. Candidate selection uses training data; holdout results remain separate.",
  "research-store": "Run market-fetch first to produce the source data.",
  "research-allocate": "Requires both /reports/btc-vst.json and /reports/eth-vst.json. Fetch both symbols first.",
  "research-report": "Run market-fetch and research-backtest first to produce /reports/research.json.",
}

export function IntegrationsPanel() {
  const [query, setQuery] = useState("")
  const [copied, setCopied] = useState("")
  const [copyError, setCopyError] = useState("")
  const items = registry.integrations.filter(item => `${item.name} ${item.role}`.toLowerCase().includes(query.toLowerCase()))
  async function copy(id: string, command: string) {
    try { await navigator.clipboard.writeText(command); setCopied(id); setCopyError("") }
    catch { setCopied(""); setCopyError("Clipboard unavailable. Select and copy the command below.") }
  }
  return <div className="terminal-integrations">
    <section className="terminal-panel">
      <header className="terminal-panel-heading"><div><p className="terminal-kicker">RESEARCH / ADAPTER INVENTORY</p><h2>Ten tools. One research workspace.</h2></div><a className="terminal-button" href="/api/terminal/export"><Download size={14} /> Paper ledger CSV</a></header>
      <div className="terminal-integration-intro"><div><FlaskConical size={22} /><p>Each adapter has an independent job: data collection, research, allocation, storage, or reporting. Research output does not place exchange orders.</p></div><div className="terminal-integration-meta"><span>{registry.distinctTestsPassed} distinct local tests passed</span><span>Checked {registry.verifiedOn}</span><span>Docker build: {registry.dockerBuildVerified ? "verified" : "not verified"}</span></div><p className="terminal-muted">{registry.scope}. Public-network checks and deployment health are listed separately below.</p></div>
    </section>
    <div className="terminal-table-search"><Search size={15} /><input aria-label="Search integrations" placeholder="Find an integration or capability" value={query} onChange={event => setQuery(event.target.value)} /><span className="terminal-tag">{items.length} adapters</span></div>
    {copyError && <p className="terminal-notice error" role="alert">{copyError}</p>}
    <div className="terminal-integration-grid">{items.map(item => {
      const service = item.composeService
      const profile = service === "freqtrade-paper" ? "freqtrade-dry-run" : service === "cryptofeed-public" ? "cryptofeed-public" : "research"
      const command = service ? `docker compose -f compose.research.yml --profile ${profile} run --rm ${service}` : null
      return <article className="terminal-panel terminal-integration-card" key={item.id}>
        <header><div className="terminal-integration-icon"><Workflow size={19} /></div><div><h3>{item.name}</h3><p>{item.role}</p></div><span className="terminal-tag">{item.versionTested}</span></header>
        <div className="terminal-integration-evidence"><span className="terminal-tag positive">{item.status === "export-verified" ? "Export verified" : "Local adapter verified"}</span><dl><dt>Local verification</dt><dd>{item.localVerification}</dd><dt>Network verification</dt><dd>{item.networkVerification}</dd><dt>Adapter</dt><dd><code>{item.adapter}</code></dd></dl></div>
        {command ? <div className="terminal-integration-command"><div><span>Run from project root</span><button className="terminal-link" onClick={() => void copy(item.id, command)}>{copied === item.id ? <Check size={13} /> : <Copy size={13} />}{copied === item.id ? "Copied" : "Copy command"}</button></div><code tabIndex={0}>{command}</code>{service && prerequisites[service] && <p>{prerequisites[service]}</p>}</div> : <div className="terminal-integration-command"><p>The native candle chart is available in Command center. This adapter also exports self-contained research charts.</p></div>}
      </article>
    })}</div>
    {!items.length && <div className="terminal-empty"><p>No integration matches this search.</p></div>}
    <a className="terminal-link" href={registry.reference} target="_blank" rel="noreferrer">View original reference <ExternalLink size={14} /></a>
  </div>
}
