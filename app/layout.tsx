import type { Metadata } from "next"
import "./globals.css"
export const metadata: Metadata = { title: "Sky Dental NYC — AI Receptionist" }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
