/** Validate before decoding any data URL or starting Storage/AI work. */
export function assertChatRequestBudget(
  messages: Array<{ parts?: Array<Record<string, unknown>> }>,
) {
  let textBytes = 0,
    fileCount = 0,
    decodedBytes = 0,
    partCount = 0;
  for (const message of messages)
    for (const part of message.parts ?? []) {
      if (++partCount > 500) throw new Error("Chat has too many content parts");
      if (part.type === "text") {
        if (typeof part.text !== "string")
          throw new Error("Chat text is invalid");
        textBytes += Buffer.byteLength(part.text);
        if (textBytes > 100_000)
          throw new Error("Chat text exceeds the context budget");
      }
      if (part.type === "file" || part.type === "image") {
        if (++fileCount > 5 || typeof part.url !== "string")
          throw new Error("Attach at most five files");
        const match =
          /^data:[a-zA-Z0-9.+/-]+;base64,([a-zA-Z0-9+/]*={0,2})$/.exec(
            part.url,
          );
        if (!match || match[1]!.length % 4 !== 0)
          throw new Error("Only valid base64 file attachments are accepted");
        const encoded = match[1]!;
        const bytes =
          (encoded.length / 4) * 3 -
          (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
        if (bytes > 5 * 1024 * 1024)
          throw new Error("Each attachment is limited to 5 MiB");
        decodedBytes += bytes;
        if (decodedBytes > 10 * 1024 * 1024)
          throw new Error("Attachments exceed the 10 MiB request budget");
      }
    }
  return { textBytes, fileCount, decodedBytes };
}
