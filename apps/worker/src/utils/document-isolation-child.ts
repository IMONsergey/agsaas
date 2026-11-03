import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { MAX_DOCUMENT_INPUT_BYTES } from "./document-limits";
import type { DocumentTask } from "./document-task-types";

// Read-only subprocess. No DB, Storage write, queue or application clients.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const body = await Bun.stdin.text();
if (Buffer.byteLength(body) > 36 * 1024 * 1024) process.exit(2);
const payload = JSON.parse(body) as { id: string; task: DocumentTask };
const task = payload.task;
function bytes(base64: string) {
  if (
    typeof base64 !== "string" ||
    base64.length > Math.ceil((MAX_DOCUMENT_INPUT_BYTES * 4) / 3) + 4
  )
    throw new Error("Input limit");
  const data = Buffer.from(base64, "base64");
  if (data.length === 0 || data.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Input limit");
  return data;
}
try {
  let result: unknown;
  if (task.kind === "parse") {
    const { loadDocument } = await import("@midday/documents/loader");
    result = await loadDocument({
      content: new Blob([new Uint8Array(bytes(task.base64))], {
        type: task.mimetype,
      }),
      metadata: { mimetype: task.mimetype },
    });
  } else if (task.kind === "image") {
    const { default: sharp } = await import("sharp");
    sharp.cache(false);
    sharp.concurrency(1);
    const image = sharp(bytes(task.base64), {
      limitInputPixels: 16_000_000,
      animated: false,
      failOn: "warning",
    });
    const meta = await image.metadata();
    if ((meta.pages ?? 1) > 1) throw new Error("Animated/multipage image");
    if (
      !["jpeg", "png", "webp", "gif", "tiff", "heif"].includes(
        meta.format ?? "",
      )
    )
      throw new Error("Unsupported image");
    if (
      !Number.isInteger(task.maxSize) ||
      task.maxSize < 64 ||
      task.maxSize > 2048
    )
      throw new Error("Image dimensions");
    const data = await image
      .rotate()
      .resize({
        width: task.maxSize,
        height: task.maxSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .timeout({ seconds: 25 })
      .toBuffer();
    if (data.length > 5 * 1024 * 1024) throw new Error("Image result limit");
    result = { base64: data.toString("base64"), mimetype: "image/jpeg" };
  } else if (
    task.kind === "classify-document" ||
    task.kind === "classify-image"
  ) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY)
      throw new Error("AI is not configured");
    const { DocumentClassifier } = await import("@midday/documents/classifier");
    const classifier = new DocumentClassifier();
    result =
      task.kind === "classify-document"
        ? await classifier.classifyDocument({ content: task.content })
        : await classifier.classifyImage({
            content: new Uint8Array(bytes(task.base64)).buffer,
          });
  } else if (task.kind === "embed-tags") {
    if (
      !process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      task.tags.length > 100 ||
      task.tags.some((s) => s.length > 200)
    )
      throw new Error("Embedding limits");
    const { Embed } = await import("@midday/documents/embed");
    result = await new Embed().embedMany(task.tags);
  } else if (task.kind === "extract") {
    if (
      !process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
      !process.env.MISTRAL_API_KEY
    )
      throw new Error("AI is not configured");
    const { DocumentClient } = await import("@midday/documents");
    result = await new DocumentClient().getInvoiceOrReceipt(task.request);
  } else throw new Error("Unknown document task");
  const response = JSON.stringify({ id: payload.id, ok: true, result });
  if (Buffer.byteLength(response) > 8 * 1024 * 1024)
    throw new Error("Output limit");
  const channel = createWriteStream("", { fd: 3 });
  const finished = once(channel, "finish");
  channel.end(response);
  await finished;
} catch {
  process.exitCode = 1;
}
