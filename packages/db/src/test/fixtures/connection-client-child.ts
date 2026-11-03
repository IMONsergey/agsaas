import { mock, spyOn } from "bun:test";
import { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseTransportTestCa } from "./database-transport-ca";
import type { PoolConfig } from "pg";

const scenario = process.argv[2];
const region = process.argv[3] ?? "us-east4-eqdc4a";
if (
  ![
    "verified",
    "plain",
    "development",
    "worker-fallback",
    "custom-ca",
    "invalid-primary",
  ].includes(scenario ?? "")
) {
  throw new Error("Unknown database transport fixture scenario");
}

let networkAttempts = 0;
spyOn(Socket.prototype, "connect").mockImplementation(() => {
  networkAttempts += 1;
  throw new Error("Database transport fixture forbids socket connections");
});
const forbidFetch = () => {
  networkAttempts += 1;
  throw new Error("Database transport fixture forbids HTTP requests");
};
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(forbidFetch, { preconnect: forbidFetch }),
);

const suffix = scenario === "plain" ? "?sslmode=disable" : "";
const url = (host: string) =>
  `postgresql://fixture:unit-test-password@${host}:5432/transport_test${suffix}`;
process.env.NODE_ENV =
  scenario === "development" ? "development" : "production";
process.env.RAILWAY_ENVIRONMENT_NAME = "production";
process.env.RAILWAY_REPLICA_REGION = region;
process.env.DATABASE_PRIMARY_URL = url("primary.database.invalid");
process.env.DATABASE_FRA_URL = url("fra.database.invalid");
process.env.DATABASE_IAD_URL = url("iad.database.invalid");
process.env.DATABASE_SJC_URL = url("sjc.database.invalid");
if (scenario === "worker-fallback")
  delete process.env.DATABASE_PRIMARY_POOLER_URL;
else process.env.DATABASE_PRIMARY_POOLER_URL = url("pooler.database.invalid");
process.env.PGSSLMODE = "no-verify";
process.env.PGSSLNEGOTIATION = "direct";
if (scenario === "invalid-primary") {
  process.env.DATABASE_PRIMARY_URL = `${url("primary.database.invalid")}?sslmode=no-verify`;
}

const actualPg = await import("pg");
const ActualClient = actualPg.Client;
const ActualPool = actualPg.Pool;
const records: Array<{
  host: string;
  ssl: unknown;
  sslnegotiation: unknown;
}> = [];

class ObservedPool extends ActualPool {
  constructor(config?: PoolConfig) {
    super(config);
    // The production client supplies its real Pool config. Feed it through the
    // actual installed pg Client/ConnectionParameters without ever connecting.
    const client = new ActualClient(config);
    const parameters: unknown = Reflect.get(client, "connectionParameters");
    if (!parameters || typeof parameters !== "object")
      throw new Error("pg connection parameters unavailable");
    records.push({
      host: client.host,
      ssl: Reflect.get(client, "ssl"),
      sslnegotiation: Reflect.get(parameters, "sslnegotiation"),
    });
  }
}
mock.module("pg", () => ({
  ...actualPg,
  default: { ...actualPg, Pool: ObservedPool },
  Pool: ObservedPool,
}));

let error: { name: string; message: string } | undefined;
let caDirectory: string | undefined;
try {
  if (scenario === "custom-ca") {
    caDirectory = mkdtempSync(join(tmpdir(), "agsaas-db-client-transport-"));
    const caPath = join(caDirectory, "fixture-ca.pem");
    writeFileSync(caPath, databaseTransportTestCa, { mode: 0o600 });
    process.env.DATABASE_SSL_CA_FILE = caPath;
  }
  const api = await import("../../client");
  const worker = await import("../../worker-client");
  const { createJobDb } = await import("../../job-client");
  const job = scenario === "worker-fallback" ? null : createJobDb();
  await Promise.all([api.closeDb(), worker.closeWorkerDb(), job?.disconnect()]);
} catch (caught) {
  error =
    caught instanceof Error
      ? { name: caught.name, message: caught.message }
      : { name: "UnknownError", message: "Unknown fixture failure" };
} finally {
  if (caDirectory) rmSync(caDirectory, { recursive: true, force: true });
}

console.log(
  `DATABASE_TRANSPORT_FIXTURE ${JSON.stringify({ records, networkAttempts, error })}`,
);
