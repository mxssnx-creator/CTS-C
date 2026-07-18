import fs from "node:fs"
import path from "node:path"

const BINGX_KEY_ALIASES = ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY"]
const BINGX_SECRET_ALIASES = ["BINGX_API_SECRET", "BINGX_SECRET", "NEXT_BINGX_API_SECRET"]

let parsedDotenv: Record<string, string> | null = null

function parseDotenvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const separator = trimmed.indexOf("=")
  if (separator <= 0) return null
  const key = trimmed.slice(0, separator).trim()
  const value = trimmed.slice(separator + 1).trim()
  return [key, value]
}

function loadDotenvFallback(): Record<string, string> {
  if (parsedDotenv) return parsedDotenv

  const files = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
  ]

  const loaded: Record<string, string> = {}
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8")
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line)
      if (!parsed) continue
      const [key, value] = parsed
      if (!(key in loaded)) loaded[key] = value
    }
  }

  parsedDotenv = loaded
  return loaded
}

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return ""
  return raw.trim().replace(/^['\"]|['\"]$/g, "")
}

export function readEnvByAliases(aliases: string[]): string {
  const dotenv = loadDotenvFallback()
  for (const key of aliases) {
    const value = cleanEnvValue(process.env[key] || dotenv[key])
    if (value.length > 0) return value
  }
  return ""
}

export function readBingxCredentialsFromEnv(): { apiKey: string; apiSecret: string; hasCredentials: boolean } {
  const apiKey = readEnvByAliases(BINGX_KEY_ALIASES)
  const apiSecret = readEnvByAliases(BINGX_SECRET_ALIASES)
  const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
  return { apiKey, apiSecret, hasCredentials }
}
