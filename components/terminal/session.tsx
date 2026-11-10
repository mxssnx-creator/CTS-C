"use client"
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { ArrowRight, LockKeyhole, Workflow } from "lucide-react"
const Session = createContext<{ logout: () => Promise<void> }>({ logout: async () => {} })
export const useTerminalSession = () => useContext(Session)
export function SessionGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/auth/me", { cache: "no-store", signal: controller.signal }).then(async response => { if (response.ok) { const body = await response.json(); setAuthenticated(body.authenticated === true) } }).catch(() => { if (!controller.signal.aborted) setError("Unable to reach the authentication service.") }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const expired = () => { setAuthenticated(false); setPassword(""); setError("Your session expired. Sign in again to continue.") }
    window.addEventListener("cts-session-expired", expired)
    return () => window.removeEventListener("cts-session-expired", expired)
  }, [])
  const logout = useCallback(async () => {
    try { const response = await fetch("/api/auth/logout", { method: "POST" }); if (!response.ok) throw new Error("Sign out failed"); setError(""); setAuthenticated(false) }
    catch { setError("Unable to sign out. Retry when the server is reachable.") }
  }, [])
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("")
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "Authentication failed")
      setPassword(""); setAuthenticated(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sign in failed") }
    finally { setBusy(false) }
  }
  if (loading) return <div className="terminal-auth"><div className="terminal-auth-card"><div className="terminal-orb"><Workflow size={28} /></div><h1>CTS-C Terminal</h1><p>Connecting to your workspace…</p></div></div>
  if (authenticated) return <Session.Provider value={{ logout }}>{error && <div className="terminal-notice error" role="alert"><span>{error}</span><button onClick={() => void logout()}>Retry sign out</button></div>}{children}</Session.Provider>
  return <div className="terminal-auth"><form className="terminal-auth-card" onSubmit={login}><div className="terminal-orb"><Workflow size={28} /></div><p className="terminal-kicker">PRIVATE TRADING WORKSPACE</p><h1>Welcome to <span>CTS-C.</span></h1><p>Sign in to manage your independent trading terminal.</p><label htmlFor="workspace-password">Workspace password</label><div className="terminal-password"><LockKeyhole size={17} /><input id="workspace-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></div>{error && <p className="terminal-login-error" role="alert">{error}</p>}<button className="terminal-button primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Open workspace"}<ArrowRight size={16} /></button><small>Exchange credentials are stored on the server.</small></form></div>
}
