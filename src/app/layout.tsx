import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { AppPrefProvider } from "@/components/app-pref-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "F1 Track Studio — 3D Circuit Viewer",
  description:
    "Interactive 3D viewer for Formula 1 circuit configurations, built with Next.js + Three.js. Unofficial, non-commercial.",
  keywords: ["F1", "Formula 1", "Three.js", "3D", "circuits", "tracks"],
  authors: [{ name: "Makakashan" }],
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <AppPrefProvider>{children}</AppPrefProvider>
        <Toaster />
      </body>
    </html>
  );
}
