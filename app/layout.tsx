// ─────────────────────────────────────────────────────────────────────────────
// app/layout.tsx
// Root layout — dark background, navigation tabs, Google Fonts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import NavTabs from "@/components/NavTabs";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title:       "TP3 · XAU/USD Terminal",
  description: "Real-time trading terminal and quantitative backtest suite for XAU/USD",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={inter.variable}>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, background: "#0B0D11" }}>
        <NavTabs />
        <main>{children}</main>
      </body>
    </html>
  );
}
