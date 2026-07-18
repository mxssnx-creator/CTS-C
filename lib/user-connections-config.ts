/**
 * Importable connection templates. Credentials are intentionally empty:
 * runtime secrets come from server-side environment variables or the secured
 * connection editor and must never be compiled into source control.
 */
export interface UserConnectionConfig {
  id: string
  name: string
  exchange: string
  displayName: string
  apiType: string
  connectionType: string
  apiKey: string
  apiSecret: string
  isTestnet: boolean
  marginType?: string
  positionMode?: string
  maxLeverage?: number
  documentation?: { npm?: string; pip?: string; official?: string }
  installCommands?: { npm?: string; pip?: string }
}

export const USER_CONNECTIONS: UserConnectionConfig[] = [
  {
    id: "bybit-x03-unified",
    name: "X03",
    exchange: "bybit",
    displayName: "Bybit X03 (Unified)",
    apiType: "unified_trading",
    connectionType: "Unified",
    apiKey: "",
    apiSecret: "",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 100,
    documentation: {
      npm: "https://www.npmjs.com/package/bybit-api/",
      pip: "https://github.com/bybit-exchange/pybit",
      official: "https://bybit-exchange.github.io/docs/v5/intro",
    },
  },
  {
    id: "bingx-x01-futures",
    name: "X01",
    exchange: "bingx",
    displayName: "BingX X01 (Futures)",
    apiType: "perpetual_futures",
    connectionType: "Futures",
    apiKey: "",
    apiSecret: "",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 150,
    documentation: {
      official: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
    },
  },
  {
    id: "pionex-x01-futures",
    name: "X01",
    exchange: "pionex",
    displayName: "Pionex X01 (Futures)",
    apiType: "futures",
    connectionType: "Futures",
    apiKey: "",
    apiSecret: "",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 100,
    documentation: { official: "https://pionex-doc.gitbook.io/apidocs/" },
  },
  {
    id: "orangex-x01-futures",
    name: "X01",
    exchange: "orangex",
    displayName: "OrangeX X01 (Futures)",
    apiType: "futures",
    connectionType: "Futures",
    apiKey: "",
    apiSecret: "",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 125,
    documentation: { official: "https://openapi-docs.orangex.com/" },
  },
]

export function getUserConnection(id: string): UserConnectionConfig | undefined {
  return USER_CONNECTIONS.find((connection) => connection.id === id)
}

export function getUserConnectionsByExchange(exchange: string): UserConnectionConfig[] {
  return USER_CONNECTIONS.filter((connection) => connection.exchange.toLowerCase() === exchange.toLowerCase())
}

export function hasUserConnection(id: string): boolean {
  return USER_CONNECTIONS.some((connection) => connection.id === id)
}
