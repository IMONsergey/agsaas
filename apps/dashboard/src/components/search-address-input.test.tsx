import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchAddressInput } from "./search-address-input";

describe("address search without a configured provider", () => {
  const originalKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;

  afterEach(() => {
    if (originalKey === undefined)
      delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_API_KEY = originalKey;
  });

  for (const key of [undefined, "   "]) {
    test(`manual-entry guidance replaces disabled Google search for ${key === undefined ? "missing" : "blank"} key`, () => {
      if (key === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
      else process.env.NEXT_PUBLIC_GOOGLE_API_KEY = key;
      let selections = 0;
      const html = renderToStaticMarkup(
        <SearchAddressInput
          defaultValue="Existing manual address"
          onSelect={() => {
            selections += 1;
          }}
        />,
      );

      expect(html).toContain("Enter the address manually below.");
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<script");
      expect(selections).toBe(0);
    });
  }
});
