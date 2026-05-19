import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "c2c Transformation Studio",
  description: "Next.js Studio shell for the c2c BFF product surface.",
  icons: {
    icon: "/favicon.svg?v=mirrored-20260517",
    shortcut: "/favicon.svg?v=mirrored-20260517",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Issue #271 / ADR-0005 §6: read the per-request CSP nonce
  // ``src/middleware.ts`` stamps on the request and thread it onto
  // Next's framework script tags. ``headers()`` is async in App
  // Router runtimes that include the Next 16 streaming pipeline.
  // ``x-nonce`` is the header name Next.js' renderer specifically
  // recognises for auto-propagation onto hydration / RSC Flight
  // ``<script>`` tags; we read it here so any explicit ``<Script>``
  // in the layout subtree can be threaded too. When the request is
  // statically generated the nonce is absent — the static asset
  // fallback CSP from ``next.config.mjs`` covers that branch.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${ibmPlexMono.variable} h-full overflow-hidden`}
        {...(nonce ? { "data-nonce": nonce } : {})}
      >
        {children}
      </body>
    </html>
  );
}
