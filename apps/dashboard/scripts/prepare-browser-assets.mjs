import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboard = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(dashboard, "package.json"));
const reactPdfEntry = require.resolve("react-pdf");
// Resolve React-PDF's exact dependency; the root PDF.js package may differ.
const reactPdfRequire = createRequire(reactPdfEntry);
const pdfPackage = reactPdfRequire.resolve("pdfjs-dist/package.json");
const pdfRoot = dirname(pdfPackage);
const { version } = JSON.parse(readFileSync(pdfPackage, "utf8"));
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Unexpected PDF.js package version");
const manifest = JSON.parse(
  readFileSync(join(dashboard, "src/utils/pdf-public-assets.json"), "utf8"),
);
const publicFiles = [
  "pdf.worker.min.mjs",
  "LICENSE",
  ...["cmaps", "standard_fonts", "wasm"].flatMap((directory) =>
    readdirSync(join(pdfRoot, directory), { withFileTypes: true }).map(
      (entry) => {
        if (!entry.isFile()) throw new Error("Unexpected nested PDF asset");
        return `${directory}/${entry.name}`;
      },
    ),
  ),
].sort();
if (
  manifest.version !== version ||
  JSON.stringify(manifest.files) !== JSON.stringify(publicFiles)
)
  throw new Error(
    "PDF dependency changed: review and update the exact public asset manifest before building",
  );
const output = join(dashboard, "public/vendor/pdfjs", version);
mkdirSync(output, { recursive: true });
const sourceWorker = join(pdfRoot, "build/pdf.worker.min.mjs");
const worker = readFileSync(sourceWorker);
cpSync(sourceWorker, join(output, "pdf.worker.min.mjs"));
for (const directory of ["cmaps", "standard_fonts", "wasm"])
  cpSync(join(pdfRoot, directory), join(output, directory), {
    recursive: true,
  });
cpSync(join(pdfRoot, "LICENSE"), join(output, "LICENSE"));
const receipt = {
  kind: "agsaas-own-pdf-assets-v1",
  version,
  workerSha256: createHash("sha256").update(worker).digest("hex"),
  publicBase: `/vendor/pdfjs/${version}/`,
  license: "LICENSE",
};
writeFileSync(
  join(output, "receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt));
