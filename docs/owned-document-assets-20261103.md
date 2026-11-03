# Own document and public-preview assets

## Scope

Invoice and receipt PDF generation, three public OG preview routes (invoice, customer portal and shared report), and uploaded company/invoice logos use the installation's assets. This source packet does not certify deployment, all screens, Auth/Storage services or complete multilingual coverage.

## Fonts

Four unmodified Liberation Sans faces are bundled as typed modules. `packages/invoice/src/fonts/manifest.json` records the exact source package, size and SHA256 of every original font. `LICENSE-Liberation.txt` carries the distribution license; the dashboard runtime image explicitly copies it, while API/worker images retain the package sources and license.

PDF rendering registers the four local faces. Public previews use direct Satori plus Sharp, with explicit dependencies and bundled fonts. We omit `loadAdditionalAsset`: Next's ImageResponse implementation otherwise downloads missing fonts and emoji from third-party services even when a primary font is provided. Latin and Cyrillic are exercised in the rendering tests. Missing emoji or CJK glyphs use the font's missing-glyph fallback; adding other scripts requires explicitly bundled font assets. We do not silently send document text to a font service.

The dashboard layout also uses local Hedvig Sans and Serif files through `next/font/local`. Their original Google Fonts repository Git blob IDs, sizes and SHA256 are pinned in `apps/dashboard/src/fonts/manifest.json`; the original bytes and OFL are retained. A dashboard build no longer needs to request these fonts from Google.

## Logo boundary

Server renderers fetch only the exact configured `NEXT_PUBLIC_SUPABASE_URL` origin and the public `avatars` bucket. They reject credentials, query strings, fragments, other buckets, external URLs, filesystem URLs and ambiguous path segments. Fetching uses no credentials and cannot follow redirects. Streamed bytes are capped at 5 MiB, raster dimensions at 16 million pixels and lifetime at 5 seconds, including stalled bodies. MIME must match a supported raster signature. A missing, invalid or unavailable logo is omitted without making the document unavailable.

Renderers receive inline raster bytes, never a persisted network URL or filesystem path. The PDF decoder accepts PNG and JPEG; new company and invoice uploads are normalized to a PNG no larger than 1024 by 1024 pixels, so they can be reused in browser, PDF and OG output. Existing GIF/WebP logos may need to be uploaded again for PDF display.

Website-domain avatars use the existing local initials fallback; no Logo.dev requests or embedded provider token remain in the helper. Company and invoice logos remain user-owned uploads.

## Verification to run

The packet contains real PDF rendering and text extraction, actual PNG rendering through all three OG route functions, no-network assertions including unsupported glyphs, exact font hash checks, loopback HTTP redirect and stalled-stream tests, and bounds for malformed images. Run these in isolated Bun processes through the shared job queue. Type checks cover dashboard, worker and API consumers. Rendering artifacts should also be viewed before accepting visual quality.

The public preview response is private/no-store so revocation or expiry is not hidden behind a long-lived image response. Production builds and actual browser flows remain separate acceptance gates.

## Remaining upstream routing closed in this packet

OAuth discovery, chat/bot MCP context and Slack destination links now use validated installation origins. The invoice MCP display path uses the same bounded own-logo loader and removes untrusted database data URIs. The upstream Sendblue contact-card side effect was removed, and invoice email previews use the own application icon. OAuth consent no longer infers a developer, provider website or familiar icon from a user-supplied application name. It labels supplied developer metadata as self-reported and displays the callback origin without query parameters. Unsafe developer website schemes and credentials do not become links.

These paths require the new route, rendering and identity regressions in addition to type checks. No messages, email or provider operations were executed during development.
