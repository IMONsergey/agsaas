import Papa from "papaparse";

export function parseCsvPreview(content: string) {
  const { data, meta } = Papa.parse<Record<string, string>>(content, {
    worker: false,
    skipEmptyLines: true,
    header: true,
  });
  if (data.length < 1) {
    return {
      success: false,
      message: "CSV file must contain at least one transaction row.",
    } as const;
  }
  if (!meta.fields || meta.fields.length <= 1) {
    return {
      success: false,
      message: "Failed to retrieve CSV column data.",
    } as const;
  }
  return { success: true, data, fields: meta.fields } as const;
}

export const readLines = async (file: File, count = 4): Promise<string> => {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Preview line count must be a positive integer");
  }
  if (file.size === 0) return "";
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let content = "";
  let bytesRead = 0;
  let done = false;
  // A preview is not a full-file read. Bound even a CSV with a huge first line.
  const maxBytes = 256 * 1024;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        content += decoder.decode();
        return content.split("\n").slice(0, count).join("\n");
      }
      const available = maxBytes - bytesRead;
      const value = chunk.value.subarray(0, available);
      bytesRead += value.byteLength;
      content += decoder.decode(value, { stream: true });
      const lines = content.split("\n");
      // A chunk can end halfway through a line. Only truncate at a known
      // newline; otherwise continue to EOF (including a final unterminated line).
      if (lines.length > count) return lines.slice(0, count).join("\n");
      if (bytesRead === maxBytes) {
        throw new Error("CSV preview exceeds the 256 KiB limit");
      }
    }
  } finally {
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};
