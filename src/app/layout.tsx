import type { Metadata, Viewport } from "next";
import { Inter, Titillium_Web } from "next/font/google";
import "./globals.css";

/** The timing overlay's typeface, and only its typeface — the rest of the app keeps the system stack. */
const timingFont = Titillium_Web({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600", "700", "900"],
  variable: "--font-timing",
  display: "swap",
});
/** The interface typeface. */
const interFont = Inter({ subsets: ["latin", "latin-ext", "cyrillic"], variable: "--font-inter", display: "swap" });
import { Toaster } from "@/components/ui/toaster";
import { AppPrefProvider } from "@/components/app-pref-provider";

const faviconUrl = "/favicon.svg";
const faviconLightUrl = "/favicon-light.svg";

const DESCRIPTION =
  "Every Formula 1 circuit in 3D in the browser: real terrain, the city around the track, and a race on top. Unofficial, non-commercial.";

export const metadata: Metadata = {
  // Link previews (Telegram, Discord, X) need absolute URLs; src/app/opengraph-image.png is the picture.
  metadataBase: new URL("https://boxlane.pages.dev"),
  title: "Boxlane — every F1 circuit in 3D",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Boxlane",
    title: "Boxlane — every F1 circuit in 3D",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: { card: "summary_large_image" },
  keywords: ["Boxlane", "F1", "Formula 1", "Three.js", "3D", "circuits", "tracks"],
  authors: [{ name: "Makakashan" }],
  icons: {
    icon: [
      { url: faviconLightUrl, type: "image/svg+xml", media: "(prefers-color-scheme: light)" },
      { url: faviconUrl, type: "image/svg+xml", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/apple-touch-icon.png",
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
      className={`dark ${timingFont.variable} ${interFont.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased bg-background text-foreground">
        <AppPrefProvider>
          {children}
        </AppPrefProvider>
        <Toaster />
      </body>
    </html>
  );
}
