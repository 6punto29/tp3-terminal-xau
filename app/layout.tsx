import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

// PWA Fase 1 (30/05/26): manifest + iconos + meta tags para iPhone.
// El "short_name" del manifest y "apple-mobile-web-app-title" controlan
// el texto debajo del icono cuando la PWA está instalada en home screen.
// iOS trunca a ~12 caracteres → "TP3 XAU/USD" (11 chars) cabe limpio.
//
// Fases siguientes (no incluidas acá):
// · Fase 2: Service Worker
// · Fase 3: Web Push real (VAPID + Supabase)
// · Fase 4: Motor server-side con Vercel Cron
export const metadata: Metadata = {
  title:       "TP3 XAU/USD Terminal",
  description: "Real-time trading terminal and quantitative backtest suite for XAU/USD",
  manifest:    "/manifest.json",
  appleWebApp: {
    capable:     true,
    title:       "TP3 XAU/USD",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon:    [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple:   [
      { url: "/icons/icon-152.png", sizes: "152x152", type: "image/png" },
      { url: "/icons/icon-167.png", sizes: "167x167", type: "image/png" },
      { url: "/icons/icon-180.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0D11",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={inter.variable} data-theme="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, background: "#0B0D11" }}>
        {children}
      </body>
    </html>
  );
}
