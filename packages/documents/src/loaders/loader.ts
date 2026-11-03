import { parseOfficeAsync } from "officeparser";
import { extractText, getDocumentProxy } from "unpdf";
import { cleanText, extractTextFromRtf } from "../utils";
import { assertBoundedOfficeArchive } from "./archive-guard";

const MAX_INPUT = 25 * 1024 * 1024,
  MAX_TEXT = 2 * 1024 * 1024;
const officeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/docx",
  "application/pptx",
]);
/** Called in the worker's isolated read-only process, never a remote OCR fallback. */
export async function loadDocument({
  content,
  metadata,
}: {
  content: Blob;
  metadata: { mimetype: string };
}) {
  if (content.size === 0 || content.size > MAX_INPUT)
    throw new Error("Document processing accepts files up to 25 MiB");
  const data = Buffer.from(await content.arrayBuffer());
  const type = metadata.mimetype;
  let text: string | null = null;
  if (type === "application/pdf" || type === "application/x-pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    try {
      if (pdf.numPages > 200)
        throw new Error("PDF exceeds 200 processing pages");
      text = (await extractText(pdf, { mergePages: true })).text ?? null;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } else if (["text/plain", "text/markdown", "text/csv"].includes(type)) {
    text = data.toString("utf8");
  } else if (type === "application/rtf") {
    text = extractTextFromRtf(data);
  } else if (officeTypes.has(type)) {
    if (data.subarray(0, 2).toString() === "PK")
      assertBoundedOfficeArchive(data);
    else if (
      type.includes("openxmlformats") ||
      type.includes("oasis") ||
      type === "application/docx" ||
      type === "application/pptx"
    )
      throw new Error("Invalid office archive");
    text = await parseOfficeAsync(data);
  } else throw new Error("Unsupported document type");
  if (text && Buffer.byteLength(text) > MAX_TEXT)
    throw new Error("Extracted document exceeds the processing text limit");
  return text ? cleanText(text) : null;
}
