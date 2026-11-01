import { Icons } from "@midday/ui/icons";
import Link from "next/link";
import type { ReactNode } from "react";
import { LoginVideoBackground } from "./login-video-background";

export function AuthFormLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background flex relative">
      <nav className="absolute top-0 left-0 z-50 p-4 xl:p-6">
        <Link
          href="/login"
          aria-label="AGSaaS sign in"
          className="block w-6 h-6"
        >
          <Icons.LogoSmall className="w-full h-full text-foreground lg:text-white" />
        </Link>
      </nav>
      <LoginVideoBackground />
      <main className="w-full lg:w-1/2 flex flex-col justify-center items-center p-8 lg:p-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-2">
            <h1 className="text-lg lg:text-xl font-serif">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
          <p className="text-center text-sm">
            <Link href="/login" className="underline underline-offset-4">
              Back to sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
