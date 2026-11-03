"use client";
import Link from "next/link";
import { useState } from "react";

type Guide = { slug: string; title: string; description: string };
export function DocumentationIndex({ guides }: { guides: Guide[] }) {
  const [query, setQuery] = useState("");
  const results = guides.filter((guide) =>
    `${guide.title} ${guide.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="space-y-8">
      <label className="block">
        <span className="block text-sm mb-2">Find a guide</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full border border-border bg-background px-4 py-3"
          placeholder="Invoices, CSV, security..."
        />
      </label>
      <p className="sr-only" aria-live="polite">
        {results.length} guides found
      </p>
      {results.length ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {results.map((guide) => (
            <Link
              href={`/docs/${guide.slug}`}
              key={guide.slug}
              className="border border-border p-5 hover:bg-secondary/40"
            >
              <h2 className="font-medium">{guide.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {guide.description}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <p>
          No guide matches your search. Try a shorter phrase or contact your
          workspace administrator.
        </p>
      )}
    </div>
  );
}
