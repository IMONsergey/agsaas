import "@/styles/globals.css";
import { cn } from "@midday/ui/cn";
import { getAppUrl } from "@midday/utils/envs";
import "@midday/ui/globals.css";
import { Provider as Analytics } from "@midday/events/client";
import { Toaster } from "@midday/ui/toaster";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactElement } from "react";
import { DesktopHeader } from "@/components/desktop-header";
import { isDesktopApp } from "@/utils/desktop";
import { Providers } from "./providers";

const dashboardUrl = getAppUrl();

export const metadata: Metadata = {
  metadataBase: new URL(dashboardUrl),
  title: "AGSaaS | Business workspace",
  description:
    "Manage customers, invoices, time tracking and business finances in one workspace.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "AGSaaS | Business workspace",
    description: "Customers, invoices, time tracking and business finances.",
    url: dashboardUrl,
    siteName: "AGSaaS",
    locale: "en_US",
    type: "website",
  },
};

const hedvigSans = localFont({
  src: "../../fonts/HedvigLettersSans-Regular.ttf",
  weight: "400",
  display: "swap",
  variable: "--font-hedvig-sans",
});

const hedvigSerif = localFont({
  src: "../../fonts/HedvigLettersSerif-Optical.ttf",
  weight: "400",
  display: "swap",
  variable: "--font-hedvig-serif",
});

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default async function Layout({
  children,
  params,
}: {
  children: ReactElement;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const isDesktop = await isDesktopApp();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(isDesktop && "desktop")}
    >
      <body
        className={cn(
          `${hedvigSans.variable} ${hedvigSerif.variable} font-sans`,
          "whitespace-pre-line overscroll-none antialiased",
        )}
      >
        <DesktopHeader />

        <NuqsAdapter>
          <Providers locale={locale}>
            {children}
            <Toaster />
          </Providers>
          <Analytics />
        </NuqsAdapter>
      </body>
    </html>
  );
}
