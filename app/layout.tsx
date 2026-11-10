import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AppearanceProvider } from "@/components/terminal/appearance"
import "./globals.css"
export const metadata: Metadata = { title: "CTS-C · Trading Terminal", description: "Independent trading terminal: market discovery, strategy evaluation, demo execution, and persistent reporting." }
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><AppearanceProvider>{children}</AppearanceProvider></body></html>
}
