import type { Metadata, Viewport } from "next";
import { Titillium_Web } from "next/font/google";
import "./globals.css";

/**
 * The timing overlay's typeface, and only its typeface — the rest of the app
 * keeps the system stack. A broadcast tower is set in a squarish humanist sans
 * with very heavy weights, and the system font at weight 900 is a different
 * letter shape, not a bolder one.
 */
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

/**
 * The page runs edge to edge, and the interface keeps clear of the cutouts.
 *
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` report anything
 * other than zero — without it a phone letterboxes the page inside the safe
 * area, the insets are all 0, and any code reading them is decoration. With it
 * the 3D scene fills the screen, notch to gesture bar, and every panel drawn
 * over the scene pays for its own inset.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Matched to the app's own background in each theme, because with `cover`
  // the strip behind the status bar is the browser's colour, not the page's.
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
  // The actual theme class (.dark / .light) is applied at runtime by
  // AppPrefProvider based on localStorage / system preference. We default to
  // "dark" here so the very first paint (before hydration) is sane.
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
