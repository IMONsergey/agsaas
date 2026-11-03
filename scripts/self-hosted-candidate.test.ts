import { expect, test } from "bun:test";
import {
  CANDIDATE,
  validateCandidateCompose,
} from "./self-hosted-candidate.mts";

function fixture() {
  const apps = ["api", "worker", "dashboard", "website"];
  const platform = [
    "db",
    "auth",
    "rest",
    "realtime",
    "storage",
    "imgproxy",
    "meta",
    "functions",
    "api-gw",
    "supavisor",
    "studio",
    "redis-cache",
    "redis-queue",
  ];
  const ports: Record<string, [number, number]> = {
    dashboard: [13500, 3000],
    api: [13503, 8080],
    website: [13501, 3000],
    "api-gw": [14000, 8000],
  };
  return {
    name: CANDIDATE.project,
    services: Object.fromEntries(
      [...apps, ...platform].map((name) => [
        name,
        {
          image: "synthetic-installed-image",
          restart: "no",
          mem_limit: 256 * 1024 * 1024,
          cpus: 1,
          pids_limit: 128,
          networks: { default: {} },
          ports: ports[name]
            ? [
                {
                  host_ip: "127.0.0.1",
                  published: String(ports[name]![0]),
                  target: ports[name]![1],
                },
              ]
            : [],
          volumes: [] as { type: string; source: string; target: string }[],
        },
      ]),
    ),
    networks: {
      default: { name: `${CANDIDATE.project}_default`, internal: true },
    },
    volumes: { "db-config": { name: `${CANDIDATE.project}_db-config` } },
  };
}
test("candidate allows only its bounded network, loopbacks and independently scoped volumes", () => {
  const config = fixture();
  config.services.db!.volumes = [
    {
      type: "bind",
      source: `${CANDIDATE.runtime}/volumes/db/data`,
      target: "/var/lib/postgresql/data",
    },
    { type: "volume", source: "db-config", target: "/etc/postgresql-custom" },
  ];
  expect(validateCandidateCompose(config).name).toBe(CANDIDATE.project);
});
test("candidate rejects production mounts, public binds, external networks and unbounded services", () => {
  const production = fixture();
  production.services.db!.volumes = [
    {
      type: "bind",
      source: "/opt/agsaas/preview-20261101/runtime/supabase/volumes/db/data",
      target: "/var/lib/postgresql/data",
    },
  ];
  expect(() => validateCandidateCompose(production)).toThrow(
    "outside fresh runtime",
  );
  const publicPort = fixture();
  publicPort.services.dashboard!.ports[0]!.host_ip = "0.0.0.0";
  expect(() => validateCandidateCompose(publicPort)).toThrow(
    "loopback profile",
  );
  const network = fixture();
  network.networks.default.internal = false;
  expect(() => validateCandidateCompose(network)).toThrow("isolated network");
  const oversized = fixture();
  oversized.services.worker!.mem_limit = 8 * 1024 ** 3;
  expect(() => validateCandidateCompose(oversized)).toThrow("resource bound");
  const alias = fixture();
  alias.volumes["db-config"].name = "agsaas-preview-20261101_db-config";
  alias.services.db!.volumes = [
    { type: "volume", source: "db-config", target: "/etc/postgresql-custom" },
  ];
  expect(() => validateCandidateCompose(alias)).toThrow("independently owned");
});
test("candidate refuses host namespaces, privileged containers and new service escapes", () => {
  const base = fixture();
  for (const patch of [
    { privileged: true },
    { pid: "host" },
    { network_mode: "host" },
    { cap_add: ["SYS_ADMIN"] },
    { devices: ["/dev/sda:/dev/sda"] },
  ]) {
    const value = structuredClone(base);
    Object.assign(value.services.worker!, patch);
    expect(() => validateCandidateCompose(value)).toThrow();
  }
  const extra = fixture();
  extra.services.unreviewed = extra.services.worker!;
  expect(() => validateCandidateCompose(extra)).toThrow("service set changed");
});
