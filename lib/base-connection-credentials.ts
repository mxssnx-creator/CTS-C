export type BaseConnectionId = "bingx-x01" | "pionex-x01" | "orangex-x01"

export type BaseConnectionCredentials = {
  apiKey: string
  apiSecret: string
}

const ENV_ALIASES: Record<BaseConnectionId, { key: string[]; secret: string[] }> = {
  "bingx-x01": {
    key: ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY"],
    secret: ["BINGX_API_SECRET", "BINGX_SECRET", "NEXT_BINGX_API_SECRET"],
  },
  "pionex-x01": {
    key: ["PIONEX_API_KEY", "NEXT_PIONEX_API_KEY"],
    secret: ["PIONEX_API_SECRET", "PIONEX_SECRET", "NEXT_PIONEX_API_SECRET"],
  },
  "orangex-x01": {
    key: ["ORANGEX_API_KEY", "NEXT_ORANGEX_API_KEY"],
    secret: ["ORANGEX_API_SECRET", "ORANGEX_SECRET", "NEXT_ORANGEX_API_SECRET"],
  },
}

function readFirstEnv(names: string[]): string {
  if (typeof process === "undefined") return ""
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return ""
}

export function getBaseConnectionCredentials(id: BaseConnectionId): BaseConnectionCredentials {
  const aliases = ENV_ALIASES[id]
  return {
    apiKey: readFirstEnv(aliases.key),
    apiSecret: readFirstEnv(aliases.secret),
  }
}

export const BASE_CONNECTION_CREDENTIALS: Record<BaseConnectionId, BaseConnectionCredentials> = {
  "bingx-x01": getBaseConnectionCredentials("bingx-x01"),
  "pionex-x01": getBaseConnectionCredentials("pionex-x01"),
  "orangex-x01": getBaseConnectionCredentials("orangex-x01"),
}
