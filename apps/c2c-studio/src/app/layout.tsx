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
  // Studio-IDE-12 (#250) follow-up: read the per-request CSP nonce
  // ``src/middleware.ts`` stamps on the request and thread it onto
  // Next's framework script tags. ``headers()`` is async in App
  // Router runtimes that include the Next 16 streaming pipeline. The
  // nonce is undefined in dev (the middleware short-circuits) and
  // when the route is statically generated — both cases fall back to
  // the dev-friendly policy from ``next.config.mjs``.
  const nonce = (await headers()).get("x-c2c-csp-nonce") ?? undefined;
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
