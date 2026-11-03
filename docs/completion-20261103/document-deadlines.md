# Document processing and operation deadlines

CPU parsing, image decode/resize, document/image classification, receipt extraction
and tag embeddings run in a separate read-only process. It receives no database,
Storage write, queue, Auth, payment or email credential. Provider keys are present
only for tasks that need their read-only inference API. Parser-only tasks receive none.

The parent accepts at most two processes, input25MiB, serialized request36MiB,
result8MiB. Parsing accepts at most200 PDF pages and2MiB extracted text.
OOXML/ODF ZIP preflight checks central/local entry consistency, paths, actual
bounded inflate,512 entries,16MiB per entry,64MiB total expansion and200x ratio
(with1MiB allowance for small XML). ZIP64, encrypted and multipart archives fail.
Image decode uses16 million pixels, one frame, JPEG output<=5MiB and25s native limit.
Unsupported HEIC stays downloadable; no unsafe unbounded decoder fallback runs.

On timeout or shutdown the parent sends SIGKILL and waits for close before rejecting.
Only the parent may publish database results. A late parser response cannot update
records or overwrite an object. HEIC conversion never overwrites the uploaded source.
Text PDF extraction is local and does not require AI keys. Scanned PDFs without text
remain stored; missing text/classification is a retriable failed processing state.

This process boundary bounds lifetime; it is not claimed as a complete OS security
sandbox. Container CPU/memory/PID limits apply to the process and its children.
Actual child peak-memory/load measurements belong in release acceptance.

withTimeout now accepts a factory that starts inside an AbortSignal context.
The worker Storage transport inherits the operation signal, including response body.
All remaining call sites start their operation in that context. A cancelled remote
write can still have committed: TimeoutError.outcome is unconfirmed, immutable
archive keys/digests and durable financial receipts remain the retry authority.
Provider read-only inference may still consume provider-side work after disconnect;
its response has no authority to mutate our database.

Meaningful checks: actual child CPU loop termination; delayed fixture cannot write
after timeout; cancellation frees the slot; local text extraction; archive traversal,
false expansion sizes, compressed bomb and truncated directory; transport abort and
nested deadlines. These checks must pass on the deployed Bun/runtime image.
