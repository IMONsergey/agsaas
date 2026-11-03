import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";

const MAX_CA_BYTES = 256 * 1024;
const MAX_CA_CERTIFICATES = 64;
const CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

type TransportEnvironment = {
  DATABASE_SSL_CA_FILE?: string;
  NODE_TLS_REJECT_UNAUTHORIZED?: string;
};

export class DatabaseTransportConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTransportConfigurationError";
  }
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function invalidUrlTlsOptions(): never {
  // Never interpolate a URL, query value, filesystem path or underlying error:
  // those can include a database password or accidentally supplied credentials.
  throw new DatabaseTransportConfigurationError(
    "Database URL TLS options must use a single sslmode=verify-full or sslmode=disable. Configure custom CAs with DATABASE_SSL_CA_FILE.",
  );
}

/** Read only an explicit operator-owned CA file, never a path from a DB URL. */
function readCaBundle(path: string): string {
  const invalid = () =>
    new DatabaseTransportConfigurationError(
      "DATABASE_SSL_CA_FILE must name an absolute regular file containing at most 256 KiB and 64 PEM certificates.",
    );
  if (
    !isAbsolute(path) ||
    path.length > 4096 ||
    path.trim() !== path ||
    hasControlCharacters(path)
  ) {
    throw invalid();
  }

  let descriptor: number | undefined;
  try {
    // O_NONBLOCK prevents opening an accidentally configured FIFO from hanging
    // before fstat. The final path component must not be a symlink.
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CA_BYTES)
      throw invalid();

    // Bound the actual read as well as stat: a file may grow after fstat.
    const buffer = Buffer.alloc(MAX_CA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > MAX_CA_BYTES) throw invalid();

    const pem = buffer.subarray(0, length).toString("utf8");
    const certificates = pem.match(CERTIFICATE_BLOCK);
    if (
      !certificates?.length ||
      certificates.length > MAX_CA_CERTIFICATES ||
      pem.replace(CERTIFICATE_BLOCK, "").trim() !== ""
    ) {
      throw invalid();
    }
    for (const certificate of certificates) new X509Certificate(certificate);
    return `${certificates.join("\n")}\n`;
  } catch {
    throw invalid();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Canonical pg transport policy for API, replicas, workers and job clients.
 * URL ssl* options otherwise replace pg's ssl object after Pool construction.
 * Consume the one supported mode here, then pass explicit SSL options and a
 * URL without TLS overrides to the actual pg parser.
 */
export function getDatabaseConnectionConfig(
  connectionString: string | undefined,
  environment: TransportEnvironment = {
    DATABASE_SSL_CA_FILE: process.env.DATABASE_SSL_CA_FILE,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  },
): Pick<PoolConfig, "connectionString" | "ssl" | "sslnegotiation"> {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new DatabaseTransportConfigurationError(
      "Database TLS does not support NODE_TLS_REJECT_UNAUTHORIZED=0.",
    );
  }

  let mode: "verify-full" | "disable" = "verify-full";
  let sanitized = connectionString;
  if (connectionString !== undefined) {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new DatabaseTransportConfigurationError(
        "Invalid database connection URL; use a postgres:// or postgresql:// URL.",
      );
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hash ||
      connectionString.trim() !== connectionString ||
      hasControlCharacters(connectionString)
    ) {
      throw new DatabaseTransportConfigurationError(
        "Invalid database connection URL; use a postgres:// or postgresql:// URL.",
      );
    }

    let hasMode = false;
    for (const [key, value] of url.searchParams) {
      if (key === "sslmode") {
        if (hasMode || (value !== "verify-full" && value !== "disable")) {
          invalidUrlTlsOptions();
        }
        hasMode = true;
        mode = value;
      } else if (
        key.toLowerCase().startsWith("ssl") ||
        key.toLowerCase() === "uselibpqcompat"
      ) {
        invalidUrlTlsOptions();
      }
    }
    url.searchParams.delete("sslmode");
    sanitized = url.toString();
  }

  if (mode === "disable") {
    // Explicit operator choice for an approved isolated plain connection.
    // A CA setting does not turn this connection into TLS or trigger file I/O.
    return {
      connectionString: sanitized,
      ssl: false,
      sslnegotiation: "postgres",
    };
  }

  const ssl: ConnectionOptions = { rejectUnauthorized: true };
  if (environment.DATABASE_SSL_CA_FILE) {
    ssl.ca = readCaBundle(environment.DATABASE_SSL_CA_FILE);
  }
  // Leave checkServerIdentity and servername to pg/TLS: the actual connection
  // hostname/IP must match the certificate. No custom callback disables it.
  return { connectionString: sanitized, ssl, sslnegotiation: "postgres" };
}
