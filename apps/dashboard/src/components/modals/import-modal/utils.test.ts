import { describe, expect, it } from "bun:test";
import { parseCsvPreview, readLines } from "./utils";

function chunkedFile(chunks: Uint8Array<ArrayBuffer>[]) {
  let reads = 0;
  let cancelled = false;
  const file = new File(chunks, "fixture.csv");
  file.stream = () =>
    new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull(controller) {
          const chunk = chunks[reads++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
  return { file, reads: () => reads, cancelled: () => cancelled };
}

describe("bounded CSV preview", () => {
  it.each([
    false,
    true,
  ])("accepts one transaction, trailing newline=%s", async (trailing) => {
    const text = `Date,Amount\n2024-01-01,10.50${trailing ? "\n" : ""}`;
    const preview = parseCsvPreview(
      await readLines(new File([text], "one.csv")),
    );
    expect(preview.success).toBe(true);
    if (preview.success) {
      expect(preview.data).toEqual([{ Date: "2024-01-01", Amount: "10.50" }]);
      expect(preview.fields).toEqual(["Date", "Amount"]);
    }
  });

  it.each([
    "",
    "Date,Amount",
    "Date,Amount\n",
    "Date,Amount\n\n",
  ])("rejects empty/header-only input %s", async (text) => {
    const preview = parseCsvPreview(
      await readLines(new File([text], "empty.csv")),
    );
    expect(preview.success).toBe(false);
  });

  it("does not truncate a final preview line at the stream chunk boundary", async () => {
    const encoder = new TextEncoder();
    const fixture = chunkedFile([
      encoder.encode("Date,Amount\n2024-01-01,1\n2024-01-02,2\n2024-01-03,12"),
      encoder.encode("34.56\n2024-01-04,4\n"),
      encoder.encode("never read"),
    ]);
    const text = await readLines(fixture.file);
    expect(text).toEndWith("2024-01-03,1234.56");
    expect(text).not.toContain("2024-01-04");
    expect(fixture.reads()).toBe(2);
    expect(fixture.cancelled()).toBe(true);
  });

  it("decodes UTF-8 characters split across chunks and preserves CRLF input", async () => {
    const bytes = new TextEncoder().encode(
      "Date,Amount,Description\r\n2024-01-01,10,Оплата",
    );
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const preview = parseCsvPreview(await readLines(chunkedFile(chunks).file));
    expect(preview.success).toBe(true);
    if (preview.success) expect(preview.data[0]?.Description).toBe("Оплата");
  });

  it("caps a file with an oversized first line and cancels its own reader", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(65);
    const fixture = chunkedFile(Array.from({ length: 100 }, () => chunk));
    await expect(readLines(fixture.file)).rejects.toThrow("256 KiB");
    expect(fixture.reads()).toBe(4);
    expect(fixture.cancelled()).toBe(true);
  });

  it("rejects nonpositive line counts", async () => {
    await expect(readLines(new File([], "fixture.csv"), 0)).rejects.toThrow(
      "positive integer",
    );
  });
});
