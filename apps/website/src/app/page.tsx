import Link from "next/link";
import { productPages } from "@/lib/product-pages";
import { workspaceUrl } from "@/lib/site";
export default function Page() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8">
      <section className="py-20 md:py-32 grid lg:grid-cols-[1.2fr_1fr] gap-12 items-center">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-7">
            Your business workspace
          </p>
          <h1 className="text-5xl md:text-7xl leading-[1.05] tracking-tight">
            Financial work.
            <br />
            One workspace.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted-foreground mt-8">
            Customers, invoices, transactions, documents and tracked time. Start
            with your own records and connect optional services when you need
            them.
          </p>
          <div className="flex flex-wrap gap-4 mt-10">
            <a
              href={workspaceUrl("/login")}
              className="bg-foreground text-background px-6 py-3"
            >
              Open workspace
            </a>
            <Link href="/docs" className="border border-border px-6 py-3">
              Read the guide
            </Link>
          </div>
        </div>
        <div className="border border-border bg-secondary/30 p-6 md:p-8">
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-6">
            A place for every part of the work
          </p>
          {[
            ["01", "Customer", "Contact and billing details"],
            ["02", "Work", "Projects and time entries"],
            ["03", "Invoice", "Documents and payment status"],
            ["04", "Records", "Transactions, receipts and exports"],
          ].map(([number, title, detail]) => (
            <div
              key={number}
              className="flex gap-5 py-5 border-t border-border"
            >
              <span className="text-xs text-muted-foreground pt-1">
                {number}
              </span>
              <div>
                <h2 className="font-medium">{title}</h2>
                <p className="text-sm text-muted-foreground mt-1">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section id="features" className="pb-16 scroll-mt-8">
        <div className="max-w-2xl mb-10">
          <h2 className="text-3xl tracking-tight">
            From the first record to the final export
          </h2>
          <p className="text-muted-foreground mt-4">
            Manual workflows are available without connecting a bank or an AI
            service.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(productPages).map(([key, page]) => (
            <Link
              key={key}
              href={`/${key}`}
              className="border border-border p-6 hover:bg-secondary/40"
            >
              <h3 className="text-lg">{page.short}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {page.lead}
              </p>
              <span className="inline-block mt-6 text-sm">Explore →</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
