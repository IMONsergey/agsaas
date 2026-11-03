import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import crypto from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import {
  decrypt,
  encrypt,
  FILE_KEY_TTL_SECONDS,
  generateFileKey,
  verifyFileKey,
} from "./index";

describe("user-bound short-lived file capabilities", () => {
  const previousSecret = process.env.FILE_KEY_SECRET;
  const fixtureSecret = "local-file-capability-key-never-deployed";
  const identity = {
    sessionId:"44444444-4444-4444-8444-444444444444",
    userId: "user-fixture",
    teamId: "team-fixture",
    aal: "aal1" as const,
  };
  beforeEach(() => {
    process.env.FILE_KEY_SECRET = fixtureSecret;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.FILE_KEY_SECRET;
    else process.env.FILE_KEY_SECRET = previousSecret;
  });

  it("signs subject, team, assurance and a five-minute maximum lifetime", async () => {
    const token = await generateFileKey(identity);
    const payload = decodeJwt(token);
    expect(await verifyFileKey(token)).toEqual(identity);
    expect(payload.exp! - payload.iat!).toBe(FILE_KEY_TTL_SECONDS);
    expect(payload.sub).toBe(identity.userId);
    expect(payload.aud).toBe("agsaas-private-files");
  });

  it("rejects existing team-only 30-day keys", async () => {
    const oldToken = await new SignJWT({ teamId: identity.teamId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(fixtureSecret));
    expect(await verifyFileKey(oldToken)).toBeNull();
  });

  it("rejects expired, excessive-lifetime and wrong-purpose signed keys without grace", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const spec of [
      { iat: now - 301, exp: now - 1, aud: "agsaas-private-files" },
      { iat: now, exp: now + 86400, aud: "agsaas-private-files" },
      { iat: now, exp: now + 300, aud: "other-purpose" },
    ]) {
      const token = await new SignJWT({
        v: 3,
        sessionId:identity.sessionId,
        teamId: identity.teamId,
        aal: "aal1",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(identity.userId)
        .setIssuer("agsaas-api")
        .setAudience(spec.aud)
        .setIssuedAt(spec.iat)
        .setExpirationTime(spec.exp)
        .sign(new TextEncoder().encode(fixtureSecret));
      expect(await verifyFileKey(token)).toBeNull();
    }
  });

  it("rejects signed version2 keys that cannot be revoked with a browser session",async()=>{
    const now=Math.floor(Date.now()/1000);
    const token=await new SignJWT({v:2,teamId:identity.teamId,aal:"aal1"})
      .setProtectedHeader({alg:"HS256"}).setSubject(identity.userId).setIssuer("agsaas-api")
      .setAudience("agsaas-private-files").setIssuedAt(now).setExpirationTime(now+300)
      .sign(new TextEncoder().encode(fixtureSecret));
    expect(await verifyFileKey(token)).toBeNull();
  });

  it("rejects a modified signature", async () => {
    const token = await generateFileKey(identity);
    const [header, payload, signature] = token.split(".");
    const changed = (signature![0] === "A" ? "B" : "A") + signature!.slice(1);
    expect(
      await verifyFileKey([header, payload, changed].join(".")),
    ).toBeNull();
  });
});

describe("Encryption/Decryption", () => {
  const plaintext = "This is a secret message.";
  const emptyPlaintext = "";
  let validKey: string;

  beforeAll(() => {
    // Generate a valid 32-byte key for testing
    validKey = crypto.randomBytes(32).toString("hex");
  });

  beforeEach(() => {
    // Set the environment variable before each test
    process.env.MIDDAY_ENCRYPTION_KEY = validKey;
  });

  it("should encrypt and decrypt a string successfully", () => {
    const encrypted = encrypt(plaintext);
    expect(typeof encrypted).toBe("string");
    // Basic check for base64 format
    expect(Buffer.from(encrypted, "base64").toString("base64")).toBe(encrypted);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("should encrypt and decrypt an empty string successfully", () => {
    const encrypted = encrypt(emptyPlaintext);
    expect(typeof encrypted).toBe("string");
    expect(Buffer.from(encrypted, "base64").toString("base64")).toBe(encrypted);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(emptyPlaintext);
  });
});
