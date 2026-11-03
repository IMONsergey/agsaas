import crypto from "node:crypto";
import * as jose from "jose";

// ============================================================================
// URL-Safe Base64 Utilities
// ============================================================================

/**
 * Converts standard base64 to URL-safe base64.
 * Replaces + with -, / with _, and removes = padding.
 * This is necessary because some OAuth providers don't properly
 * encode + characters in query strings, which corrupts standard base64.
 *
 * @param base64 - Standard base64 encoded string
 * @returns URL-safe base64 string
 */
export function toUrlSafeBase64(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Converts URL-safe base64 back to standard base64.
 * Replaces - with +, _ with /, and adds = padding.
 *
 * @param urlSafeBase64 - URL-safe base64 string
 * @returns Standard base64 string
 */
export function fromUrlSafeBase64(urlSafeBase64: string): string {
  let base64 = urlSafeBase64.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }
  return base64;
}

/**
 * Encrypts an OAuth state payload for use in URL parameters.
 * Uses AES-256-GCM encryption with URL-safe base64 encoding.
 *
 * @param payload - The state object to encrypt (must be JSON-serializable)
 * @returns Encrypted, URL-safe string
 *
 * @example
 * const state = encryptOAuthState({ teamId: "123", userId: "456", source: "settings" });
 * // Use in OAuth redirect URL: `?state=${state}`
 */
export function encryptOAuthState<T>(payload: T): string {
  const encrypted = encrypt(JSON.stringify(payload));
  return toUrlSafeBase64(encrypted);
}

/**
 * Decrypts and validates an OAuth state from a callback URL.
 * Returns null if decryption fails or validation doesn't pass.
 *
 * @param encryptedState - The encrypted state string from the OAuth callback
 * @param validate - Optional validation function to verify the payload structure
 * @returns The decrypted payload, or null if invalid
 *
 * @example
 * const state = decryptOAuthState(params.state, (parsed) =>
 *   typeof parsed.teamId === "string" && typeof parsed.userId === "string"
 * );
 */
export function decryptOAuthState<T>(
  encryptedState: string,
  validate?: (parsed: unknown) => parsed is T,
): T | null {
  try {
    const standardBase64 = fromUrlSafeBase64(encryptedState);
    const decrypted = decrypt(standardBase64);
    const parsed = JSON.parse(decrypted);

    if (validate && !validate(parsed)) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Encryption Utilities
// ============================================================================

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.MIDDAY_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("MIDDAY_ENCRYPTION_KEY environment variable is not set.");
  }
  if (Buffer.from(key, "hex").length !== 32) {
    throw new Error(
      "MIDDAY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).",
    );
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param text The plaintext string to encrypt.
 * @returns A string containing the IV, auth tag, and encrypted text, concatenated and base64 encoded.
 */
export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Concatenate IV, auth tag, and encrypted data
  const encryptedPayload = Buffer.concat([
    iv,
    authTag,
    Buffer.from(encrypted, "hex"),
  ]).toString("base64");

  return encryptedPayload;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * @param encryptedPayload The base64 encoded string containing the IV, auth tag, and encrypted text.
 * @returns The original plaintext string.
 */
export function decrypt(encryptedPayload: string): string {
  const key = getKey();

  if (!encryptedPayload || typeof encryptedPayload !== "string") {
    throw new Error("Invalid encrypted payload: must be a non-empty string");
  }

  const dataBuffer = Buffer.from(encryptedPayload, "base64");
  const minLength = IV_LENGTH + AUTH_TAG_LENGTH;

  if (dataBuffer.length < minLength) {
    throw new Error(
      `Invalid encrypted payload: too short. Expected at least ${minLength} bytes, got ${dataBuffer.length}`,
    );
  }

  // Extract IV, auth tag, and encrypted data
  const iv = dataBuffer.subarray(0, IV_LENGTH);
  const authTag = dataBuffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encryptedText = dataBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`,
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText.toString("hex"), "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function hash(str: string): string {
  return crypto.createHash("sha256").update(str).digest("hex");
}

export const FILE_KEY_TTL_SECONDS = 5 * 60;
const FILE_KEY_AUDIENCE = "agsaas-private-files";
const FILE_KEY_ISSUER = "agsaas-api";

export type FileKeyIdentity = {
  sessionId: string;
  userId: string;
  teamId: string;
  aal: "aal1" | "aal2";
};

/** The HTTP boundary must recheck this user's current team membership. */
export async function generateFileKey(
  identity: FileKeyIdentity,
): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identity.sessionId,
    ) ||
    !identity.userId ||
    !identity.teamId ||
    !["aal1", "aal2"].includes(identity.aal)
  ) {
    throw new Error("Invalid file access identity");
  }
  const secret = process.env.FILE_KEY_SECRET;
  if (!secret) {
    throw new Error("FILE_KEY_SECRET environment variable is not set.");
  }
  const secretKey = new TextEncoder().encode(secret);
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await new jose.SignJWT({
    v: 3,
    sessionId: identity.sessionId,
    teamId: identity.teamId,
    aal: identity.aal,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(identity.userId)
    .setAudience(FILE_KEY_AUDIENCE)
    .setIssuer(FILE_KEY_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + FILE_KEY_TTL_SECONDS)
    .sign(secretKey);
  return token;
}

/** Reject legacy team-only keys and require the dedicated, bounded session-bound v3 token. */
export async function verifyFileKey(
  token: string,
): Promise<FileKeyIdentity | null> {
  try {
    const secret = process.env.FILE_KEY_SECRET;
    if (!secret) {
      return null;
    }
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jose.jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
      issuer: FILE_KEY_ISSUER,
      audience: FILE_KEY_AUDIENCE,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: FILE_KEY_TTL_SECONDS,
      clockTolerance: 0,
    });
    if (
      payload.v !== 3 ||
      typeof payload.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        payload.sessionId,
      ) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.teamId !== "string" ||
      !payload.teamId ||
      (payload.aal !== "aal1" && payload.aal !== "aal2") ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > FILE_KEY_TTL_SECONDS
    ) {
      return null;
    }
    return {
      sessionId: payload.sessionId,
      userId: payload.sub,
      teamId: payload.teamId,
      aal: payload.aal,
    };
  } catch {
    return null;
  }
}
