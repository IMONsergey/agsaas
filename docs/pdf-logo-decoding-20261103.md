# Server PDF logo decoding — 2026-11-03

## Problem and rendering boundary

The common logo loader validates raster headers and bounds the fetch, but a
header is not proof that compressed pixels can be decoded. The installed PDF
dependency's PNG decoder inflates IDAT and can throw from its asynchronous
callback. Passing an untrusted, header-valid PNG directly into that decoder
can disrupt PDF generation; a request-level catch is not a reliable fix for an
asynchronous throw.

`@midday/invoice/server` now owns server PDF rendering inputs. Its
`PdfTemplate` fetches and decodes the optional logo before handing a newly
encoded PNG to the shared template. Invalid bytes, decode warnings or a
processing timeout omit the logo while preserving the invoice/receipt content.

The production callers are:

- `apps/worker/src/processors/invoices/generate-invoice.ts`
- `apps/api/src/rest/routers/files/download.ts`
- `apps/api/src/mcp/tools/invoices.ts`

All three import the PDF template and renderer through the explicit server
entrypoint. The common `@midday/invoice` and `templates/pdf` entrypoints no
longer fetch a persisted logo. They accept an internal `preparedLogo` option
and otherwise render without one. This makes an unchanged caller safe by
default. The branded string is a compile-time integration contract, not an
authorization check or a runtime proof against trusted application code that
deliberately casts arbitrary bytes.

## Native dependency and browser boundary

Sharp is declared as `catalog:` in the invoice workspace, using the existing
root catalog pin 0.35.5. Its only invoice-package import is in `src/server.ts`.
The common index and shared templates never import that module. The
`./server` package export has `browser: null`, with its normal default target
pointing to the server source, so browser-condition resolution rejects it.

The server module intentionally does not import Next's `server-only` marker:
ordinary Bun/Node workers do not use React server conditions. The separate
dashboard OG wrapper retains that marker. The OG wrapper remains independent
so an OG logo load does not import the PDF renderer just to reuse a normalizer.

This packet does not edit `bun.lock`. The queued integration install must
resolve and record the workspace dependency before the final source freeze.

## Data and resource limits

The unchanged `loadPublicLogo` runs once. It permits only the configured own
Storage origin and public avatars path, refuses redirects and credentials,
limits the response to 5 MiB, and aborts its fetch after at most five seconds.
For PDF logos it still accepts only PNG and JPEG input.

The server normalizer converts that already-fetched data URL to a bounded
Buffer and uses Sharp with strict `failOn: "warning"`, a 16-million input
pixel limit, first page/frame only and EXIF orientation. It fits the raster
inside 1024 × 1024 without enlarging and creates PNG output with metadata
stripped by the normal Sharp output path. The output must have positive bounded
dimensions, PNG format and a size no greater than 5 MiB.

Sharp's three-second timeout covers native processing after libvips opens the
input. It excludes time spent waiting for a libuv thread, so it is not a total
request deadline or a global concurrency limit. No detached `Promise.race`,
second network request, filesystem path, raw SVG or custom image codec is used.

This limits the trusted PNG subsequently passed to the PDF decoder. It is not
a claim that the underlying PDF dependency safely decodes arbitrary PNG input.

## Regression gate and status

The actual offline PDF suite now uses the server entrypoint and preserves all
existing invoice/receipt, four font styles, Cyrillic, own-URL and unsafe-URL
assertions. Its three malformed-logo cases cover an invalid IDAT CRC, corrupt
IDAT bytes and a truncated IHDR; they render the actual PDF and parse its text.
A further real-render case verifies that the shared entrypoint never fetches
or embeds a persisted logo without explicit preparation.

The PDF harness keeps its socket fence. The only exception adopts the exact
extra stdio descriptor used by the real isolated document parser under Bun
1.3.11: an internal child-process/document-task call site plus an anonymous pipe
or connected, unnamed AF_UNIX stream verified through Linux descriptor metadata.
TCP, pathname sockets and arbitrary caller-supplied descriptors stay denied.
A regression exercises those denied forms. This is a test harness exception,
not a general sandbox or production network policy. Unknown descriptor shapes
or unsupported platforms fail closed.

The expected PDF suite contains 11 cases; this count is a source inventory,
not an execution result.

The route-boundary, invoice-delivery and global API fakes target the server
entrypoint, preserving their existing authorization and handoff assertions.
The separate QR-origin suite still exercises the common template.

Source formatting and diff review are separate from runtime verification.
Actual decoding, PDF text extraction, API/worker types, package resolution and
the dashboard production build must run through the shared queue before this
packet is reported as passing. No native rendering was run during preparation.

## Primary API references

- https://sharp.pixelplumbing.com/api-constructor/
- https://sharp.pixelplumbing.com/api-output/
- https://sharp.pixelplumbing.com/api-resize/
- https://nodejs.org/api/packages.html#conditional-exports
- https://bun.com/docs/bundler
- https://github.com/oven-sh/bun/blob/bun-v1.3.11/src/js/node/child_process.ts
- https://github.com/oven-sh/bun/blob/bun-v1.3.11/src/js/node/net.ts
