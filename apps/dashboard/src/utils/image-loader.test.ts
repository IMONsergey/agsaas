import { describe, expect, test } from "bun:test";
import imageLoader from "../../image-loader";

describe("image origin and private file credentials", () => {
  const sources = [
    "https://instance.example.test/files/proxy?filePath=team%2Freceipt.png&fk=fixture-no-secret",
    "/files/proxy?filePath=team%2Freceipt.png&fk=fixture-no-secret",
    "http://127.0.0.1:3003/files/proxy?fk=fixture-no-secret",
    "/_next/static/media/logo.hash.png",
    "https://own-storage.example.test/storage/v1/object/public/avatars/logo.png",
  ];
  for (const src of sources) {
    test(`does not forward ${src.split("?")[0]} to another origin`, () => {
      for (const width of [64, 320, 640, 1280]) {
        expect(imageLoader({ src, width, quality: 80 })).toBe(src);
      }
    });
  }
});
