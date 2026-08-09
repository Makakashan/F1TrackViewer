import type { Metadata, Viewport } from "next";
import { Titillium_Web } from "next/font/google";
import "./globals.css";

/** The timing overlay's typeface, and only its typeface — the rest of the app keeps the system stack. */
const timingFont = Titillium_Web({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600", "700", "900"],
  variable: "--font-timing",
  display: "swap",
});
import { Toaster } from "@/components/ui/toaster";
import { AppPrefProvider } from "@/components/app-pref-provider";
import IntroGate from "@/components/intro-gate";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const faviconUrl = `${basePath}/favicon.svg`;

export const metadata: Metadata = {
  title: "F1 Track Studio — 3D Circuit Viewer",
  description:
    "Interactive 3D viewer for Formula 1 circuit configurations, built with Next.js + Three.js. Unofficial, non-commercial.",
  keywords: ["F1", "Formula 1", "Three.js", "3D", "circuits", "tracks"],
  authors: [{ name: "Makakashan" }],
  icons: {
    icon: [{ url: faviconUrl, type: "image/svg+xml" }],
    shortcut: faviconUrl,
    apple: faviconUrl,
  },
};

/** The page runs edge to edge, and the interface keeps clear of the cutouts. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Matched to the app's own background in each theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9fafb" },
    { media: "(prefers-color-scheme: dark)", color: "#060809" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The theme class is applied at runtime by AppPrefProvider.
  return (
    <html
      lang="en"
      className={`dark ${timingFont.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased bg-background text-foreground">
        <AppPrefProvider>
          <IntroGate>{children}</IntroGate>
        </AppPrefProvider>
        <Toaster />
      </body>
    </html>
  );
}
