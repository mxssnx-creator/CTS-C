import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const ignoredDirectories = new Set([".git", ".next", ".v0-data", "node_modules", "coverage", "backups"])
const allowedSensitiveValues = /^(|redacted|replace|placeholder|example|default|changeme|your[-_])/i
const findings = []

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesIn(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function inspectJson(value, file, keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectJson(item, file, [...keyPath, String(index)]))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...keyPath, key]
    if (typeof child === "string" && /(api[_-]?(key|secret)|password|private[_-]?key|access[_-]?token)$/i.test(key)) {
      if (child.trim() && !allowedSensitiveValues.test(child.trim())) {
        findings.push(`${path.relative(root, file)}:${nextPath.join(".")} contains a non-placeholder secret value`)
      }
    } else {
      inspectJson(child, file, nextPath)
    }
  }
}

for (const file of await filesIn(root)) {
  const relative = path.relative(root, file)
  const name = path.basename(file)
  if (/^\.env(\.|$)/.test(name) && name !== ".env.example") {
    findings.push(`${relative} is an environment secret file`)
    continue
  }
  if (/\.(pem|p12|pfx)$/i.test(name)) findings.push(`${relative} is private-key material`)
  if ((await stat(file)).size > 5_000_000) continue

  let text
  try { text = await readFile(file, "utf8") } catch { continue }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push(`${relative} embeds a private key`)
  if (/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/.test(text)) {
    findings.push(`${relative} contains a recognized credential token`)
  }
  if (/\.(?:[cm]?[jt]sx?)$/.test(name)) {
    const assignmentPattern = /\b(?:api[_-]?(?:key|secret)|api(?:Key|Secret)|password|private[_-]?key|access[_-]?token)\s*[:=]\s*["'`]([^"'`]+)["'`]/g
    for (const match of text.matchAll(assignmentPattern)) {
      const value = match[1].trim()
      if (value.length >= 8 && !allowedSensitiveValues.test(value) && !/^\$\{/.test(value)) {
        findings.push(`${relative} contains a hard-coded credential assignment`)
      }
    }
  }
  if (name.endsWith(".json") && name !== "package-lock.json") {
    try { inspectJson(JSON.parse(text), file) } catch { /* not all JSON-like files are strict JSON */ }
  }
}

if (findings.length) {
  console.error("Secret boundary check failed:\n" + findings.map((item) => `- ${item}`).join("\n"))
  process.exit(1)
}

console.log("Secret boundary check passed")
