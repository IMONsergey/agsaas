# Public OG logo decoding — 2026-11-03

## Scope and failure behavior

The three dashboard public image routes (invoice, customer portal and shared
report) use `src/utils/public-og-logo.server.ts` before the existing
Satori → Sharp renderer. The helper imports `server-only`; native Sharp stays
inside the dashboard server graph. The shared invoice package and its browser
and PDF entry points do not acquire a Sharp dependency.

The earlier common `loadPublicLogo` checks magic bytes and dimensions but does
not validate an entire raster. A PNG with a plausible IHDR and broken IDAT/CRC,
or an image truncated after its dimensions, could reach the final renderer and
prevent an otherwise valid public preview. The OG helper treats a logo as
optional: decode, transform or processing failure returns `null`, leaving the
existing route's no-logo layout in place. Missing and expired records keep
their existing behavior.

## Data and resource boundary

1. Call the unchanged common loader exactly once. It still restricts requests
   to the explicitly configured own Storage origin and public avatars path,
   rejects redirects, does not send credentials, accepts only PNG/JPEG/WebP/GIF,
   and bounds downloaded bytes to 5 MiB, header dimensions to 16 million pixels,
   and the fetch to at most five seconds.
2. Decode the returned inline bytes into a Buffer. No URL, filesystem path,
   raw SVG, or second fetch is passed to Sharp.
3. Use the already declared Sharp 0.35.5 with `failOn: "warning"`, a 16-million
   input pixel ceiling, and only the first frame/page. Apply EXIF orientation,
   fit within 1024 × 1024 without enlarging, and encode PNG. Sharp's normal
   output path strips metadata; the helper does not opt into preserving it.
4. Verify the output PNG's positive bounded dimensions and byte size before
   constructing the inline data URL used by Satori.

The native processing timeout is three seconds. Sharp documents that this
clock starts when libvips opens the input and excludes waiting for a free libuv
thread. It is not an end-to-end HTTP deadline or a concurrency/admission limit.
The helper does not use a `Promise.race` that would leave unobserved native work
running after an early return.

## Regression coverage and execution status

`apps/dashboard/src/app/opengraph-offline.test.tsx` keeps the existing real
three-route tests, own-origin one-fetch assertions, untrusted URL rejection,
bundled-font behavior, missing-record cases and expired-report case.

Added cases pass malformed own-origin PNGs through the real common loader and
real Sharp decoder: invalid IDAT CRC, corrupt IDAT bytes and an IHDR truncated
after its dimensions. Each case checks helper rejection and renders all three
actual public routes to a 1200 × 630 PNG with exactly one logo fetch per route.
A valid wide JPEG verifies that the same helper returns a resized PNG.

Only the test harness mocks the `server-only` marker because generic Bun
conditions intentionally reject that package. It does not mock the logo
loader, Satori, Sharp, or the three route modules. Fetch is replaced with one
exact own-origin fixture URL and socket access is denied.

This packet is source-only until the parent runs the isolated suite and
dashboard type/build checks through the shared queue. It does not claim a
passing render or production deployment before those receipts exist.

## PDF boundary

PDF templates continue to use the common bounded loader and their existing
renderer. This OG change does not establish that the PDF renderer handles
every malformed raster safely, and the OG regressions are not a PDF decoder
acceptance test. The existing PDF styles, fonts and own-URL tests remain in
their separate gate.

## Primary API references

- Constructor, Buffer input, strict failure policy, pixel limit and page/frame
  selection: https://sharp.pixelplumbing.com/api-constructor/
- PNG output, metadata removal and native processing timeout:
  https://sharp.pixelplumbing.com/api-output/
- Inside fitting without enlargement:
  https://sharp.pixelplumbing.com/api-resize/
