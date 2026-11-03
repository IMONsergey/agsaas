import type { ReactNode } from "react";
export function InformationPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-8 py-16 md:py-24">
      <h1 className="text-4xl md:text-5xl tracking-tight">{title}</h1>
      {intro && (
        <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
          {intro}
        </p>
      )}
      <div className="mt-10 space-y-6 text-sm leading-relaxed">{children}</div>
    </article>
  );
}
