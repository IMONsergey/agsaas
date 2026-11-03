import Link from "next/link";
import { type ProductPageKey, productPages } from "@/lib/product-pages";
import { workspaceUrl } from "@/lib/site";

export function ProductPage({ page }: { page: ProductPageKey }) {
  const data = productPages[page];
  return (
    <article className="max-w-6xl mx-auto px-4 sm:px-8 py-16 md:py-24">
      <p className="text-xs uppercase tracking-widest text-muted-foreground mb-6">
        {data.short}
      </p>
      <h1 className="max-w-3xl text-4xl md:text-6xl tracking-tight leading-[1.1]">
        {data.title}
      </h1>
      <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-foreground">
        {data.lead}
      </p>
      <a
        href={workspaceUrl(data.path)}
        className="inline-flex mt-8 bg-foreground text-background px-5 py-3 text-sm"
      >
        Open {data.short.toLowerCase()}
      </a>
      <div className="grid md:grid-cols-2 gap-12 mt-20">
        <section>
          <h2 className="text-xl mb-6">What you can do</h2>
          <ul className="space-y-4 text-muted-foreground">
            {data.points.map((point) => (
              <li key={point} className="border-l-2 border-border pl-4">
                {point}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="text-xl mb-6">Get started</h2>
          <ol className="list-decimal pl-5 space-y-4 text-muted-foreground">
            {data.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </div>
      <aside className="mt-12 border border-border p-6 text-sm leading-relaxed text-muted-foreground">
        {data.note}
      </aside>
      <Link
        href="/docs"
        className="inline-block mt-8 underline underline-offset-4"
      >
        Read the workspace guide
      </Link>
    </article>
  );
}
