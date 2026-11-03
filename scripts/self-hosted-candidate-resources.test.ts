import { expect, test } from "bun:test";
import {
  CANDIDATE_BUILDER,
  validateCandidateBuilder,
  validateCandidateProviderEnvironment,
  validateCandidateQuarantine,
} from "./self-hosted-candidate.mts";

const description = `Name: ${CANDIDATE_BUILDER}
Driver: docker-container
Nodes:
Name: ${CANDIDATE_BUILDER}0
Endpoint: unix:///var/run/docker.sock
Status: running
`;
function builder() {
  return {
    Id: "1".repeat(64),
    Name: `/buildx_buildkit_${CANDIDATE_BUILDER}0`,
    Image: `sha256:${"2".repeat(64)}`,
    State: { Running: true },
    Config: { Image: `moby/buildkit@sha256:${"3".repeat(64)}` },
    HostConfig: {
      Memory: 3 * 1024 ** 3,
      MemorySwap: 3 * 1024 ** 3,
      NanoCpus: 0,
      CpuPeriod: 100000,
      CpuQuota: 200000,
      PidsLimit: 256,
      NetworkMode: "bridge",
      PortBindings: null,
    },
    Mounts: [
      {
        Type: "volume",
        Name: `buildx_buildkit_${CANDIDATE_BUILDER}0_state`,
        Destination: "/var/lib/buildkit",
      },
    ],
  };
}
test("candidate accepts the actual bounded single local BuildKit container", () => {
  expect(validateCandidateBuilder(description, builder())).toMatchObject({
    name: CANDIDATE_BUILDER,
    cpus: 2,
    pids: 256,
    memoryBytes: 3 * 1024 ** 3,
  });
});
test("candidate rejects unbounded CPU, RAM, swap, PIDs, mutable images and remote/multi-node builders", () => {
  for (const change of [
    { Memory: 0 },
    { MemorySwap: -1 },
    { CpuQuota: -1 },
    { NanoCpus: 4e9 },
    { PidsLimit: 0 },
  ]) {
    const data = builder();
    Object.assign(data.HostConfig, change);
    expect(() => validateCandidateBuilder(description, data)).toThrow();
  }
  const mutable = builder();
  mutable.Config.Image = "moby/buildkit:latest";
  expect(() => validateCandidateBuilder(description, mutable)).toThrow();
  expect(() =>
    validateCandidateBuilder(
      description.replace("docker-container", "docker"),
      builder(),
    ),
  ).toThrow();
  expect(() =>
    validateCandidateBuilder(
      description.replace("unix:///var/run/docker.sock", "ssh://remote"),
      builder(),
    ),
  ).toThrow();
  expect(() =>
    validateCandidateBuilder(
      description +
        "Name: second-node\nEndpoint: unix:///var/run/docker.sock\n",
      builder(),
    ),
  ).toThrow();
});
test("candidate rejects real provider configuration including newly discovered prefixes", () => {
  for (const key of [
    "ENABLE_BANKING_KEY_CONTENT",
    "COMPOSIO_API_KEY",
    "MISTRAL_API_KEY",
    "LOGO_DEV_TOKEN",
    "R2_SECRET_ACCESS_KEY",
    "COMPANY_ENRICH_API_KEY",
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "NEXT_PUBLIC_POSTHOG_KEY",
  ]) {
    expect(() =>
      validateCandidateProviderEnvironment({
        [key]: "synthetic-nonempty-proof",
      }),
    ).toThrow();
    expect(() =>
      validateCandidateProviderEnvironment({ [key]: "" }),
    ).not.toThrow();
  }
  expect(() =>
    validateCandidateProviderEnvironment({
      AGSAAS_SUPPORT_INGEST_KEY: "own-installation-only",
      SUPABASE_SECRET_KEY: "own-platform-only",
    }),
  ).not.toThrow();
});

const quarantinedBuilder = {
  containerId: "1".repeat(64),
  imageId: `sha256:${"2".repeat(64)}`,
  image: `moby/buildkit@sha256:${"3".repeat(64)}`,
};
const quarantine = {
  protocol: 1,
  project: "agsaas-candidate-20261103",
  operationId: "4".repeat(32),
  adapterPid: 1234,
  builder: quarantinedBuilder,
};
test("candidate build accepts only its own parent operation and exact builder quarantine", () => {
  expect(() =>
    validateCandidateQuarantine(
      quarantine,
      "4".repeat(32),
      1234,
      quarantinedBuilder,
    ),
  ).not.toThrow();
  for (const changed of [
    undefined,
    { ...quarantine, protocol: 2 },
    { ...quarantine, adapterPid: 999 },
    { ...quarantine, operationId: "5".repeat(32) },
    {
      ...quarantine,
      builder: { ...quarantinedBuilder, containerId: "6".repeat(64) },
    },
  ]) {
    expect(() =>
      validateCandidateQuarantine(
        changed,
        "4".repeat(32),
        1234,
        quarantinedBuilder,
      ),
    ).toThrow();
  }
  expect(() =>
    validateCandidateQuarantine(quarantine, undefined, 1234),
  ).toThrow();
  expect(() =>
    validateCandidateQuarantine(quarantine, "4".repeat(32), 1),
  ).toThrow();
});
