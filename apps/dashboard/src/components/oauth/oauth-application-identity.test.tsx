import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OAuthApplicationIdentity } from "./oauth-application-identity";

describe("OAuth application identity presentation", () => {
  test("does not invent a developer or provider website when metadata is absent", () => {
    const html = renderToStaticMarkup(
      <OAuthApplicationIdentity redirectUri="https://client.example.test:8443/callback?state=private" />,
    );
    expect(html).toContain("Developer not provided");
    expect(html).toContain("self-reported");
    expect(html).toContain("https://client.example.test:8443");
    expect(html).not.toContain("private");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Midday");
  });
  test.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:secret@developer.example.test",
    "http://developer.example.test",
  ])("never makes unsafe developer metadata an actionable link", (website) => {
    const html = renderToStaticMarkup(
      <OAuthApplicationIdentity
        developerName="Unverified app"
        website={website}
        redirectUri="https://client.example.test/callback"
      />,
    );
    expect(html).toContain("Unverified app");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("secret");
  });
  test("identifies a supplied developer as self-reported and retains a valid https link", () => {
    const html = renderToStaticMarkup(
      <OAuthApplicationIdentity
        developerName="Example Developer"
        website="https://developer.example.test/about"
        redirectUri="http://127.0.0.1:4321/callback"
      />,
    );
    expect(html).toContain('href="https://developer.example.test/about"');
    expect(html).toContain("self-reported");
    expect(html).toContain("http://127.0.0.1:4321");
  });
});
