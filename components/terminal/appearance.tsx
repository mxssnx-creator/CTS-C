"use client"
import { useEffect, useState, type ReactNode } from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { Palette, SlidersHorizontal } from "lucide-react"
const themes = ["dark", "light", "slate", "ocean", "monochrome"]
const styles = ["studio", "precision", "minimal", "soft", "compact"]
function applyStyle(style: string) {
  document.documentElement.dataset.workspaceStyle = style
}
export function AppearanceProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const sync = () => {
      let saved = "studio"
      try { saved = localStorage.getItem("cts-c-design") || "studio" } catch {}
      applyStyle(styles.includes(saved) ? saved : "studio")
      window.dispatchEvent(new Event("cts-design-change"))
    }
    sync(); window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])
  return <ThemeProvider attribute="class" themes={themes} defaultTheme="dark" storageKey="cts-c-theme" enableSystem={false} disableTransitionOnChange>{children}</ThemeProvider>
}
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return <label className="terminal-appearance" title="Color theme"><Palette size={15} /><select aria-label="Color theme" value={mounted ? theme : "dark"} onChange={e => setTheme(e.target.value)}>{themes.map(value => <option key={value} value={value}>{value === "dark" ? "Obsidian" : value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
}
export function StyleSwitcher() {
  const [style, setStyle] = useState("studio")
  useEffect(() => {
    const sync = () => setStyle(document.documentElement.dataset.workspaceStyle || "studio")
    sync(); window.addEventListener("cts-design-change", sync)
    return () => window.removeEventListener("cts-design-change", sync)
  }, [])
  return <label className="terminal-appearance" title="Workspace style"><SlidersHorizontal size={15} /><select aria-label="Workspace style" value={style} onChange={e => { const next = e.target.value; applyStyle(next); setStyle(next); try { localStorage.setItem("cts-c-design", next) } catch {} }}>{styles.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
}
