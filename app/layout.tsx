import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/providers"
import { IndicationGeneratorProvider } from "@/components/indication-generator-hook"

// Build timestamp: 2026-04-10T13:07
export const metadata: Metadata = {
  title: "CTS v4 Production Dashboard",
  description: "Continuous crypto trading, progression and risk dashboard",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>
          <IndicationGeneratorProvider>
            {children}
          </IndicationGeneratorProvider>
        </Providers>
      </body>
    </html>
  )
}
