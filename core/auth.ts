import { store } from "./store"
import { createAuthService } from "./auth-policy"

// Keep the login limiter across module reloads in the single Node process.
const shared = globalThis as typeof globalThis & { __ctsCAuth?: ReturnType<typeof createAuthService> }
const auth = shared.__ctsCAuth ||= createAuthService(store, {
  password: () => process.env.CTS_ADMIN_PASSWORD,
  secureCookie: () => process.env.CTS_COOKIE_SECURE === "true",
})
export const { requireAdmin, login, logout, currentUser } = auth
