import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { fstatSync, readFileSync, readlinkSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { PdfTemplate, renderToBuffer } from "@midday/invoice/server";
import type { EditorDoc, Invoice } from "@midday/invoice/types";
import { syntheticInvoice } from "../../../../../packages/invoice/src/test/fixtures/invoice";
import {
  documentInputBase64,
  runDocumentTask,
} from "../../utils/document-isolation";

const priorFetch = globalThis.fetch;
const priorConnect = Socket.prototype.connect;
let requests: string[] = [];

/** Match only Bun 1.3.11 adopting the isolated child's anonymous stdio channel.
 * The reviewed offline PDF harness uses the same boundary; arbitrary caller
 * descriptors, TCP endpoints and filesystem socket paths remain forbidden.
 */
function isDocumentChildStdioConnect(args: readonly unknown[]): boolean {
  if (process.platform !== "linux" || args.length !== 1) return false;
  const normalized = args[0];
  if (!Array.isArray(normalized) || normalized.length !== 2) return false;
  const [options, listener] = normalized;
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, "fd") ||
    (listener !== null && listener !== undefined)
  )
    return false;
  const fd = (options as { fd: unknown }).fd;
  if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 3)
    return false;
  const stack = new Error().stack ?? "";
  if (
    !/#(?:createStdioObject|getBunSpawnIo) \(node:child_process:/.test(stack) ||
    !stack.includes("runDocumentTask") ||
    !stack.includes("/document-isolation.ts:")
  )
    return false;
  try {
    const descriptor = fstatSync(fd);
    const target = readlinkSync(`/proc/self/fd/${fd}`);
    if (descriptor.isFIFO() && /^pipe:\[\d+\]$/.test(target)) return true;
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (!descriptor.isSocket() || !inode) return false;
    return readFileSync("/proc/self/net/unix", "utf8")
      .split("\n")
      .slice(1)
      .some((line) => {
        const columns = line.trim().split(/\s+/);
        return (
          columns.length === 7 &&
          columns[4] === "0001" &&
          columns[5] === "03" &&
          columns[6] === inode
        );
      });
  } catch {
    return false;
  }
}

beforeAll(() => {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      const prefix = "data:application/octet-stream;base64,";
      if (url.startsWith(prefix) && url.length === prefix.length + 95648) {
        const encoded = url.slice(prefix.length);
        const bytes = Buffer.from(encoded, "base64");
        if (
          bytes.toString("base64") === encoded &&
          createHash("sha256").update(bytes).digest("hex") ===
            "7ba9c9483c8c38a468e9aef4a95ed72fad8a43594be8e5123eb3bdb6479edf5b"
        )
          return new Response(bytes, {
            headers: { "content-type": "application/wasm" },
          });
      }
      requests.push(
        url.startsWith("data:") ? "unreviewed inline resource" : url,
      );
      throw new Error("External document network forbidden");
    },
    {
      preconnect: () => {
        throw new Error("External document network forbidden");
      },
    },
  );
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    if (isDocumentChildStdioConnect(args))
      return Reflect.apply(priorConnect, this, args);
    throw new Error("External document socket forbidden");
  };
});
beforeEach(() => {
  requests = [];
});
afterAll(() => {
  globalThis.fetch = priorFetch;
  Socket.prototype.connect = priorConnect;
});

function fourFaces(character: string): EditorDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `Regular ${character} ` },
          {
            type: "text",
            text: `Bold ${character} `,
            marks: [{ type: "bold" }],
          },
          {
            type: "text",
            text: `Italic ${character} `,
            marks: [{ type: "italic" }],
          },
          {
            type: "text",
            text: `BoldItalic ${character}`,
            marks: [{ type: "bold" }, { type: "italic" }],
          },
        ],
      },
    ],
  };
}

async function renderInvoice(number: string, character: string, title: string) {
  const invoice: Invoice = {
    ...syntheticInvoice,
    invoiceNumber: number,
    fromDetails: fourFaces(character),
    template: {
      ...syntheticInvoice.template,
      logoUrl: null,
      includeQr: false,
      title,
    },
  };
  return renderToBuffer(await PdfTemplate(invoice));
}

async function extract(buffer: Buffer, artifact: string) {
  expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  if (process.env.AGSAAS_RENDER_ARTIFACT_DIR)
    await Bun.write(
      join(process.env.AGSAAS_RENDER_ARTIFACT_DIR, artifact),
      buffer,
    );
  return runDocumentTask(
    {
      kind: "parse",
      base64: documentInputBase64(buffer),
      mimetype: "application/pdf",
    },
    { timeoutMs: 10000 },
  );
}

function expectFourFaces(text: string | null, character: string) {
  for (const label of ["Regular", "Bold", "Italic", "BoldItalic"])
    expect(text).toContain(`${label} ${character}`);
}

describe("invoice font cache across real PDF documents", () => {
  test("Cyrillic subsetting does not erase later Latin C in any owned face", async () => {
    const first = await renderInvoice("WARM-001", "С", "Счёт");
    const firstText = await extract(first, "font-cache-cyrillic-first.pdf");
    expect(firstText).toContain("Счёт");
    expectFourFaces(firstText, "С");

    // Keep the same process, FontStore and fontkit objects for the second PDF.
    const second = await renderInvoice("OWN-CORRUPT-LOGO", "C", "Invoice");
    const secondText = await extract(second, "font-cache-latin-second.pdf");
    expect(secondText).toContain("OWN-CORRUPT-LOGO");
    expectFourFaces(secondText, "C");
    expect(requests).toEqual([]);
  });

  test("parallel real PDF calls preserve each document and shared font metadata", async () => {
    const cases = [
      { number: "PARALLEL-C-1", character: "C", title: "Invoice" },
      { number: "PARALLEL-C-2", character: "С", title: "Счёт" },
      { number: "PARALLEL-C-3", character: "C", title: "Invoice" },
    ];
    const buffers = await Promise.all(
      cases.map((entry) =>
        renderInvoice(entry.number, entry.character, entry.title),
      ),
    );
    // Extraction stays serial to respect the separate two-child admission cap.
    for (const [index, entry] of cases.entries()) {
      const buffer = buffers[index];
      if (!buffer) throw new Error("A parallel PDF result is missing");
      const text = await extract(
        buffer,
        `font-cache-parallel-${index + 1}.pdf`,
      );
      expect(text).toContain(entry.number);
      expectFourFaces(text, entry.character);
      for (const other of cases)
        if (other !== entry) expect(text).not.toContain(other.number);
    }
    expect(requests).toEqual([]);
  });
});
