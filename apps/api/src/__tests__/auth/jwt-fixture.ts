import { afterAll, mock } from "bun:test";
import * as jose from "jose";

// No auth provider or configured credentials are used by these tests.
const originalUrl = process.env.SUPABASE_URL;
const originalSecret = process.env.SUPABASE_JWT_SECRET;
export const issuer = "https://local-auth.example.test/auth/v1";
const localSecret = "auth-regression-test-only-local-signing-secret";
process.env.SUPABASE_URL = "https://local-auth.example.test";
process.env.SUPABASE_JWT_SECRET = localSecret;

export const actorId = "11111111-1111-4111-8111-111111111111";
export const actorEmail = "actor@example.test";
export const inviteeEmail = "invitee@example.test";

const es256 = await jose.generateKeyPair("ES256");
const rs256 = await jose.generateKeyPair("RS256");
const localKeySet = jose.createLocalJWKSet({
  keys: [
    { ...(await jose.exportJWK(es256.publicKey)), kid: "local-ES256" },
    { ...(await jose.exportJWK(rs256.publicKey)), kid: "local-RS256" },
  ],
});

// Replace only key discovery. jwtVerify still verifies real signatures,
// expiry and claims against locally generated keys.
mock.module("jose", () => ({
  ...jose,
  createRemoteJWKSet: () => localKeySet,
}));

export const { verifyAccessToken } = await import("../../utils/auth");

export async function signAccessToken(
  claims: jose.JWTPayload = {},
  algorithm: "ES256" | "RS256" | "HS256" = "ES256",
) {
  const now = Math.floor(Date.now() / 1000);
  const keys = {
    ES256: es256.privateKey,
    RS256: rs256.privateKey,
    HS256: new TextEncoder().encode(localSecret),
  };

  return new jose.SignJWT({
    sub: actorId,
    email: actorEmail,
    aud: "authenticated",
    iss: issuer,
    role: "authenticated",
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm, kid: `local-${algorithm}` })
    .sign(keys[algorithm]);
}

afterAll(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = originalSecret;
});
