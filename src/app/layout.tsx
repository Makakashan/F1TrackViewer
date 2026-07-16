import type { Metadata } from "next";
import "./globals.css";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The actual theme class (.dark / .light) is applied at runtime by
  // AppPrefProvider based on localStorage / system preference. We default to
  // "dark" here so the very first paint (before hydration) is sane.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <AppPrefProvider>
          <IntroGate>{children}</IntroGate>
        </AppPrefProvider>
        <Toaster />
      </body>
    </html>
  );
}
