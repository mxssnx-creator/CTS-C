"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

interface User {
  id: string
  username: string
  email: string
  role: string
}

interface AuthContextType {
  user: User | null
  token: null
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  register: (username: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => Promise<void>
  isLoading: boolean
}

interface AuthResponse {
  success?: boolean
  error?: string
  data?: { user?: User }
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

async function readJson(response: Response): Promise<AuthResponse> {
  try {
    return (await response.json()) as AuthResponse
  } catch {
    return { success: false, error: `Authentication request failed (${response.status})` }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const applyResponse = useCallback(async (response: Response) => {
    const body = await readJson(response)
    const nextUser = body.data?.user
    if (response.ok && body.success && nextUser) {
      setUser(nextUser)
      return { success: true as const }
    }
    return { success: false as const, error: body.error || "Authentication failed" }
  }, [])

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        let response = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
        if (response.status === 401) {
          response = await fetch("/api/auth/auto-login", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        }

        if (!active) return
        const result = await applyResponse(response)
        if (!result.success) setUser(null)
      } catch {
        if (active) setUser(null)
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void bootstrap()
    return () => {
      active = false
    }
  }, [applyResponse])

  const login = useCallback(async (email: string, password: string) => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      return applyResponse(response)
    } catch {
      return { success: false, error: "Authentication service is unavailable" }
    }
  }, [applyResponse])

  const register = useCallback(async (username: string, email: string, password: string) => {
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      })
      return applyResponse(response)
    } catch {
      return { success: false, error: "Registration service is unavailable" }
    }
  }, [applyResponse])

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthContextType>(() => ({
    user,
    token: null,
    login,
    register,
    logout,
    isLoading,
  }), [isLoading, login, logout, register, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) throw new Error("useAuth must be used within an AuthProvider")
  return context
}
