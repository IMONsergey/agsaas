import { once } from "node:events";
import { createWriteStream, writeFileSync } from "node:fs";

const request = JSON.parse(await Bun.stdin.text());
if (
  request.task.kind === "classify-document" &&
  request.task.content.startsWith("late:")
) {
  writeFileSync(request.task.content.slice(5) + ".ready", "ready");
  await Bun.sleep(1000);
  writeFileSync(request.task.content.slice(5), "late side effect");
}
if (
  request.task.kind === "classify-document" &&
  request.task.content.startsWith("busy:")
) {
  writeFileSync(request.task.content.slice(5), "ready");
  for (;;) {}
}
const out = createWriteStream("", { fd: 3 });
const done = once(out, "finish");
out.end(
  JSON.stringify({
    id: request.id,
    ok: true,
    result: {
      title: "fixture",
      summary: null,
      tags: null,
      date: null,
      language: null,
    },
  }),
);
await done;
