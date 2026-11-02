import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { Socket } from "node:net";
import {
  LIMITS,
  NETWORK,
  PROJECT,
  relayPair,
  validateSnapshot,
} from "./rehearsal-ingress.mts";

function fixture() {
  const network = {
    Id: "a".repeat(64),
    Name: NETWORK,
    Internal: true,
    Driver: "bridge",
    Scope: "local",
    Labels: {
      "com.docker.compose.project": PROJECT,
      "com.docker.compose.network": "default",
    },
    IPAM: { Config: [{ Subnet: "172.31.1.0/24" }] },
  };
  const containers = [
    ["dashboard", `${PROJECT}-dashboard-1`],
    ["api", `${PROJECT}-api-1`],
    ["api-gw", `${PROJECT}-envoy`],
    ["mailpit", `${PROJECT}-mailpit-1`],
  ].map(([service, name], index) => ({
    Id: String(index + 1).repeat(64),
    Name: `/${name}`,
    State: {
      Running: true,
      Status: "running",
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    Config: {
      Labels: {
        "com.docker.compose.project": PROJECT,
        "com.docker.compose.service": service,
      },
    },
    NetworkSettings: {
      Networks: {
        [NETWORK]: {
          NetworkID: network.Id,
          IPAddress: `172.31.1.${index + 2}`,
        },
      } as Record<string, { NetworkID: string; IPAddress: string }>,
    },
  }));
  return { network, containers };
}

test("accepts only fixed identities and returns immutable sanitized targets", () => {
  const { network, containers } = fixture();
  const snapshot = validateSnapshot(network, containers.reverse());
  assert.deepEqual(
    snapshot.targets.map(({ listen, port }) => [listen, port]),
    [
      [3400, 3000],
      [3403, 8080],
      [3900, 8000],
      [3925, 8025],
    ],
  );
  assert.equal(snapshot.targets[2]!.ip, "172.31.1.4");
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.targets));
  assert(Object.isFrozen(snapshot.targets[0]));
  assert(!JSON.stringify(snapshot).includes("Config"));
});

const rejectCases: Array<[string, (data: ReturnType<typeof fixture>) => void]> =
  [
    [
      "external egress network",
      ({ network }) => {
        network.Internal = false;
      },
    ],
    [
      "wrong network project",
      ({ network }) => {
        network.Labels["com.docker.compose.project"] = "agsaas-stage";
      },
    ],
    [
      "wrong network name",
      ({ network }) => {
        network.Name = "agsaas-stage_default";
      },
    ],
    [
      "non-bridge network",
      ({ network }) => {
        network.Driver = "host";
      },
    ],
    [
      "multiple container networks",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks.other = {
          NetworkID: "b".repeat(64),
          IPAddress: "1.2.3.4",
        };
      },
    ],
    [
      "network ID mismatch",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.NetworkID =
          "b".repeat(64);
      },
    ],
    [
      "container from active stage",
      ({ containers }) => {
        containers[0]!.Config.Labels["com.docker.compose.project"] =
          "agsaas-stage";
      },
    ],
    [
      "wrong service label",
      ({ containers }) => {
        containers[2]!.Config.Labels["com.docker.compose.service"] = "envoy";
      },
    ],
    [
      "wrong container name",
      ({ containers }) => {
        containers[0]!.Name = "/arbitrary";
      },
    ],
    [
      "outside subnet",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.IPAddress =
          "172.31.2.4";
      },
    ],
    [
      "invalid IPv4",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.IPAddress =
          "172.31.1.999";
      },
    ],
    [
      "IPv6 endpoint",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.IPAddress = "::1";
      },
    ],
    [
      "network base address",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.IPAddress =
          "172.31.1.0";
      },
    ],
    [
      "broadcast address",
      ({ containers }) => {
        containers[0]!.NetworkSettings.Networks[NETWORK]!.IPAddress =
          "172.31.1.255";
      },
    ],
    [
      "duplicate endpoint",
      ({ containers }) => {
        containers[1]!.NetworkSettings.Networks[NETWORK]!.IPAddress =
          "172.31.1.2";
      },
    ],
    [
      "invalid immutable ID",
      ({ containers }) => {
        containers[0]!.Id = "short";
      },
    ],
    [
      "stopped container",
      ({ containers }) => {
        containers[0]!.State.Running = false;
      },
    ],
    [
      "paused container",
      ({ containers }) => {
        containers[0]!.State.Paused = true;
      },
    ],
    [
      "restarting container",
      ({ containers }) => {
        containers[0]!.State.Restarting = true;
      },
    ],
    [
      "dead container",
      ({ containers }) => {
        containers[0]!.State.Dead = true;
      },
    ],
    [
      "malformed subnet",
      ({ network }) => {
        network.IPAM.Config[0]!.Subnet = "172.31.1.0/99";
      },
    ],
    [
      "loopback subnet",
      ({ network }) => {
        network.IPAM.Config[0]!.Subnet = "127.0.0.0/8";
      },
    ],
    [
      "public subnet",
      ({ network }) => {
        network.IPAM.Config[0]!.Subnet = "8.8.8.0/24";
      },
    ],
    [
      "multiple subnets",
      ({ network }) => {
        network.IPAM.Config.push({ Subnet: "172.31.2.0/24" });
      },
    ],
    [
      "missing target",
      ({ containers }) => {
        containers.pop();
      },
    ],
  ];
for (const [name, mutate] of rejectCases) {
  test(`rejects ${name}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(
      () => validateSnapshot(data.network, data.containers),
      /safety validation failed/,
    );
  });
}

test("identity changes are observable even when replacement remains otherwise valid", () => {
  const data = fixture();
  const initial = JSON.stringify(
    validateSnapshot(data.network, data.containers),
  );
  data.containers[0]!.Id = "e".repeat(64);
  assert.notEqual(
    JSON.stringify(validateSnapshot(data.network, data.containers)),
    initial,
  );
});

test("socket error closes both sides and releases one slot exactly once", () => {
  const client = new Socket();
  const upstream = new Socket();
  let releases = 0;
  const close = relayPair(client, upstream, () => {
    releases += 1;
  });
  client.emit("error", new Error("private payload must not be logged"));
  close();
  upstream.emit("error", new Error("late error"));
  assert.equal(client.destroyed, true);
  assert.equal(upstream.destroyed, true);
  assert.equal(releases, 1);
});

test("combined traffic in either direction consumes one fixed byte budget", () => {
  const client = new Socket();
  const upstream = new Socket();
  let releases = 0;
  const close = relayPair(client, upstream, () => {
    releases += 1;
  });
  // Remove piping only: metering and lifecycle are the real production handlers.
  client.unpipe(upstream);
  upstream.unpipe(client);
  client.emit("data", Buffer.alloc(LIMITS.bytes / 2));
  upstream.emit("data", Buffer.alloc(LIMITS.bytes / 2));
  assert.equal(releases, 0);
  upstream.emit("data", Buffer.alloc(1));
  assert.equal(releases, 1);
  assert(client.destroyed && upstream.destroyed);
  close();
  assert.equal(releases, 1);
});

test("idle timeout closes the pair without leaving a live connection slot", () => {
  const client = new Socket();
  const upstream = new Socket();
  let releases = 0;
  relayPair(client, upstream, () => {
    releases += 1;
  });
  assert.equal(client.timeout, LIMITS.idleMs);
  assert.equal(upstream.timeout, LIMITS.idleMs);
  upstream.emit("timeout");
  assert.equal(releases, 1);
  assert(client.destroyed && upstream.destroyed);
});
