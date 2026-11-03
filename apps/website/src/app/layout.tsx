import "@/styles/globals.css";
import "@midday/ui/globals.css";
import { Toaster } from "@midday/ui/toaster";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(site.websiteUrl),
  title: {
    default: "AGSaaS | Your business workspace",
    template: "%s | AGSaaS",
  },
  description: site.description,
  robots: { index: site.indexable, follow: site.indexable },
  openGraph: {
    title: "AGSaaS",
    description: site.description,
    url: site.websiteUrl,
    siteName: "AGSaaS",
    type: "website",
  },
};
export const viewport = { width: "device-width", initialScale: 1 };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.className} bg-background text-foreground antialiased`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-background focus:p-4"
        >
          Skip to content
        </a>
        <NuqsAdapter>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <Header />
            <main id="main" className="min-w-0">
              {children}
            </main>
            <Footer />
            <Toaster />
          </ThemeProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
