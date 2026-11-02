import { execFile } from "node:child_process";
import { createServer, isIP, type Server, Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Temporary host access to one internal Docker network. No Docker mutations.
export const PROJECT = "agsaas-rehearsal-20261101";
export const NETWORK = `${PROJECT}_default`;
export const LIMITS = Object.freeze({
  ttlMs: 15 * 60_000,
  inspectMs: 5_000,
  refreshMs: 5_000,
  idleMs: 30_000,
  connections: 32,
  bytes: 32 * 1024 * 1024,
});
const TARGETS = [
  {
    service: "dashboard",
    name: `${PROJECT}-dashboard-1`,
    port: 3000,
    listen: 3400,
  },
  { service: "api", name: `${PROJECT}-api-1`, port: 8080, listen: 3403 },
  { service: "api-gw", name: `${PROJECT}-envoy`, port: 8000, listen: 3900 },
  {
    service: "mailpit",
    name: `${PROJECT}-mailpit-1`,
    port: 8025,
    listen: 3925,
  },
] as const;
type RecordValue = Record<string, unknown>;
export type Snapshot = Readonly<{
  networkId: string;
  subnet: string;
  targets: ReadonlyArray<
    Readonly<{ id: string; ip: string; port: number; listen: number }>
  >;
}>;

function fail(): never {
  // Docker inspection includes environment values. Never propagate raw details.
  throw new Error("Rehearsal ingress safety validation failed");
}
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as RecordValue;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function ipv4(value: unknown): number {
  if (typeof value !== "string" || isIP(value) !== 4) fail();
  return value.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}
function subnetRange(value: unknown) {
  if (typeof value !== "string") fail();
  const parts = value.split("/");
  if (parts.length !== 2 || !/^(?:[1-9]|[12][0-9]|30)$/.test(parts[1]!)) fail();
  const base = ipv4(parts[0]);
  const size = 2 ** (32 - Number(parts[1]));
  if (base % size !== 0) fail();
  const end = base + size - 1;
  const privateRanges = [
    [ipv4("10.0.0.0"), ipv4("10.255.255.255")],
    [ipv4("172.16.0.0"), ipv4("172.31.255.255")],
    [ipv4("192.168.0.0"), ipv4("192.168.255.255")],
  ];
  if (!privateRanges.some(([start, last]) => base >= start! && end <= last!))
    fail();
  return { base, end, subnet: value };
}

/** Pure validator. Only these sanitized identities are retained between checks. */
export function validateSnapshot(
  network: unknown,
  containers: unknown,
): Snapshot {
  const net = object(network);
  const labels = object(net.Labels);
  if (
    net.Name !== NETWORK ||
    net.Internal !== true ||
    net.Driver !== "bridge" ||
    net.Scope !== "local" ||
    labels["com.docker.compose.project"] !== PROJECT ||
    labels["com.docker.compose.network"] !== "default"
  )
    fail();
  const networkId = id(net.Id);
  const configs = object(net.IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1) fail();
  const range = subnetRange(object(configs[0]).Subnet);
  if (!Array.isArray(containers) || containers.length !== TARGETS.length)
    fail();
  const seen = new Set<string>();
  const targets = TARGETS.map((target) => {
    const matches = containers.filter(
      (item) => object(item).Name === `/${target.name}`,
    );
    if (matches.length !== 1) fail();
    const container = object(matches[0]);
    const state = object(container.State);
    const config = object(container.Config);
    const containerLabels = object(config.Labels);
    if (
      state.Running !== true ||
      state.Status !== "running" ||
      state.Paused !== false ||
      state.Restarting !== false ||
      state.Dead !== false ||
      containerLabels["com.docker.compose.project"] !== PROJECT ||
      containerLabels["com.docker.compose.service"] !== target.service
    )
      fail();
    const networks = object(object(container.NetworkSettings).Networks);
    if (Object.keys(networks).length !== 1 || !(NETWORK in networks)) fail();
    const endpoint = object(networks[NETWORK]);
    const ip = endpoint.IPAddress;
    const address = ipv4(ip);
    if (
      endpoint.NetworkID !== networkId ||
      address <= range.base ||
      address >= range.end
    )
      fail();
    const containerId = id(container.Id);
    if (seen.has(containerId) || seen.has(ip as string)) fail();
    seen.add(containerId);
    seen.add(ip as string);
    return Object.freeze({
      id: containerId,
      ip: ip as string,
      port: target.port,
      listen: target.listen,
    });
  });
  return Object.freeze({
    networkId,
    subnet: range.subnet,
    targets: Object.freeze(targets),
  });
}

const execute = promisify(execFile);
async function inspect(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execute(
      "/usr/bin/docker",
      ["--host", "unix:///var/run/docker.sock", ...args],
      {
        encoding: "utf8",
        timeout: LIMITS.inspectMs,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        env: {},
      },
    );
    return JSON.parse(stdout);
  } catch {
    fail();
  }
}
async function snapshot(): Promise<Snapshot> {
  const [networks, containers] = await Promise.all([
    inspect(["network", "inspect", NETWORK]),
    inspect(["container", "inspect", ...TARGETS.map((target) => target.name)]),
  ]);
  if (!Array.isArray(networks) || networks.length !== 1) fail();
  return validateSnapshot(networks[0], containers);
}

/** Shared bidirectional byte budget and paired cleanup; never logs payloads. */
export function relayPair(
  client: Socket,
  upstream: Socket,
  released: () => void,
): () => void {
  let closed = false;
  let bytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
    released();
  };
  const meter = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > LIMITS.bytes) close();
  };
  for (const socket of [client, upstream]) {
    socket.setTimeout(LIMITS.idleMs, close);
    socket.on("error", close);
    socket.on("close", close);
    socket.on("data", meter);
  }
  client.pipe(upstream);
  upstream.pipe(client);
  return close;
}

export async function runIngress(): Promise<void> {
  const initial = await snapshot();
  const identity = JSON.stringify(initial);
  const servers: Server[] = [];
  const connections = new Set<() => void>();
  let stopped = false;
  let checking = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolveDone) => {
    done = resolveDone;
  });
  const stop = (failed = false) => {
    if (stopped) return;
    stopped = true;
    if (failed) {
      process.exitCode = 1;
      process.stderr.write(
        "Rehearsal ingress failed; all listeners and connections closed.\n",
      );
    }
    if (interval) clearInterval(interval);
    if (expiry) clearTimeout(expiry);
    for (const server of servers) server.close();
    for (const close of [...connections]) close();
    done();
  };
  const signal = () => stop();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    expiry = setTimeout(() => stop(), LIMITS.ttlMs);
    for (const target of initial.targets) {
      if (stopped) break;
      const server = createServer({ pauseOnConnect: true }, (client) => {
        if (stopped || checking || connections.size >= LIMITS.connections) {
          client.destroy();
          return;
        }
        const upstream = new Socket();
        let close!: () => void;
        close = relayPair(client, upstream, () => connections.delete(close));
        connections.add(close);
        upstream.once("connect", () => client.resume());
        upstream.connect(target.port, target.ip);
      });
      servers.push(server);
      server.on("error", () => stop(true));
      await Promise.race([
        new Promise<void>((ready, reject) => {
          server.once("error", reject);
          server.listen(target.listen, "127.0.0.1", () => {
            server.removeListener("error", reject);
            if (stopped) server.close();
            ready();
          });
        }),
        finished,
      ]);
      // A signal may arrive while listen() is pending. Do not reopen a
      // listener after stop() or continue starting the remaining ports.
      if (stopped) {
        server.close();
        break;
      }
    }
    if (stopped) return;
    interval = setInterval(async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        if (JSON.stringify(await snapshot()) !== identity) stop(true);
      } catch {
        stop(true);
      } finally {
        checking = false;
      }
    }, LIMITS.refreshMs);
    process.stdout.write(
      "Rehearsal ingress ready on loopback; expires in 15 minutes.\n",
    );
    await finished;
  } catch {
    stop(true);
    throw new Error("Rehearsal ingress stopped; diagnostic details suppressed");
  } finally {
    stop();
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: sudo -n /opt/imon-runtime/node/bin/node scripts/rehearsal-ingress.mts\nFixed rehearsal only: loopback 3400, 3403, 3900, 3925. Read-only Docker inspection; 15-minute TTL. No options or environment overrides.\n",
    );
  } else if (args.length !== 0) {
    process.stderr.write("Only --help or no arguments are accepted.\n");
    process.exitCode = 1;
  } else {
    runIngress().catch(() => {
      if (process.exitCode !== 1) {
        process.stderr.write(
          "Rehearsal ingress failed; all listeners and connections closed.\n",
        );
      }
      process.exitCode = 1;
    });
  }
}
