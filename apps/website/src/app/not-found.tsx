import Link from "next/link";
export default function NotFound() {
  return (
    <section className="max-w-3xl mx-auto px-4 py-24">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-4xl mt-4">This page could not be found</h1>
      <p className="mt-6 text-muted-foreground">
        The address may be incorrect or the page may no longer be available.
      </p>
      <div className="flex flex-wrap gap-4 mt-8">
        <Link href="/" className="bg-foreground text-background px-5 py-3">
          Go to homepage
        </Link>
        <Link href="/docs" className="border border-border px-5 py-3">
          Open the guide
        </Link>
      </div>
    </section>
  );
}
