import type { DocumentClient } from "@midday/documents";
import type { DocumentClassifier } from "@midday/documents/classifier";
import type { Embed } from "@midday/documents/embed";
export type DocumentTask =
  | { kind: "parse"; mimetype: string; base64: string }
  | { kind: "classify-document"; content: string }
  | { kind: "classify-image"; base64: string }
  | { kind: "embed-tags"; tags: string[] }
  | {
      kind: "extract";
      request: Parameters<DocumentClient["getInvoiceOrReceipt"]>[0];
    }
  | { kind: "image"; base64: string; mimetype: string; maxSize: number };
export type DocumentTaskResult<T extends DocumentTask> = T extends {
  kind: "parse";
}
  ? string | null
  : T extends { kind: "classify-document" }
    ? Awaited<ReturnType<DocumentClassifier["classifyDocument"]>>
    : T extends { kind: "classify-image" }
      ? Awaited<ReturnType<DocumentClassifier["classifyImage"]>>
      : T extends { kind: "embed-tags" }
        ? Awaited<ReturnType<Embed["embedMany"]>>
        : T extends { kind: "extract" }
          ? Awaited<ReturnType<DocumentClient["getInvoiceOrReceipt"]>>
          : { base64: string; mimetype: "image/jpeg" };
