/** Local login panel: no upstream media, tracking or borrowed customer claims. */
export function LoginVideoBackground() {
  return (
    <aside className="hidden lg:flex lg:w-1/2 relative overflow-hidden m-2 bg-[#151a23] text-white">
      <div className="relative flex flex-col justify-center p-12 xl:p-20 w-full">
        <p className="text-sm uppercase tracking-[0.25em] text-white/60 mb-8">
          AGSaaS
        </p>
        <h2 className="font-serif text-4xl xl:text-5xl leading-tight mb-6">
          Your workspace for the work behind your business.
        </h2>
        <p className="text-base leading-relaxed text-white/70 max-w-md">
          Manage customers, invoices, transactions, documents and tracked time
          in one workspace.
        </p>
        <ul className="mt-12 space-y-4 text-sm text-white/70">
          <li>Start with manual entry and CSV imports.</li>
          <li>Keep financial records and supporting files together.</li>
          <li>Connect optional services when your installation is ready.</li>
        </ul>
      </div>
    </aside>
  );
}
