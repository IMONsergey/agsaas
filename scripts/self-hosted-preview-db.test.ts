import { describe, expect, test } from "bun:test";
import {
  PREVIEW,
  validatePreviewContainer,
  validatePreviewEnvironment,
} from "./self-hosted-preview-db.mts";

function environment() {
  const password = "a".repeat(64);
  return {
    COMPOSE_PROJECT_NAME: PREVIEW.project,
    AGSAAS_SOURCE_DIR: PREVIEW.source,
    AGSAAS_DASHBOARD_URL: PREVIEW.dashboard,
    AGSAAS_API_URL: PREVIEW.api,
    SUPABASE_PUBLIC_URL: PREVIEW.supabase,
    SITE_URL: PREVIEW.dashboard,
    API_EXTERNAL_URL: `${PREVIEW.supabase}/auth/v1`,
    DISABLE_SIGNUP: "true",
    ENABLE_EMAIL_AUTOCONFIRM: "false",
    AUTH_ENABLED_PROVIDERS: "password",
    FUNCTIONS_VERIFY_JWT: "true",
    COMPOSE_FILE:
      "docker-compose.yml:platform.compose.yml:compose.apps.yml:compose.preview.yml",
    AGSAAS_DB_PASSWORD: password,
    POOLER_TENANT_ID: PREVIEW.project,
    AGSAAS_DATABASE_URL: `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable`,
    AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.${PREVIEW.project}:${password}@supavisor:6543/postgres?sslmode=disable`,
  };
}

function container() {
  return {
    Id: "b".repeat(64),
    Name: `/${PREVIEW.container}`,
    Config: {
      Image: PREVIEW.image,
      Labels: {
        "com.docker.compose.project": PREVIEW.project,
        "com.docker.compose.service": "db",
        "com.docker.compose.project.working_dir": PREVIEW.runtime,
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    Mounts: [
      {
        Type: "bind",
        Source: `${PREVIEW.runtime}/volumes/db/data`,
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
  };
}

describe("separate public preview deployment boundaries", () => {
  test("accepts the exact isolated deployment identity", () => {
    expect(validatePreviewEnvironment(environment())).toBe("a".repeat(64));
    expect(validatePreviewContainer(container())).toBe("b".repeat(64));
  });

  test.each([
    "agsaas-stage",
    "agsaas-rehearsal-20261101",
    "imonmeets",
  ])("rejects another project: %s", (project) => {
    expect(() =>
      validatePreviewEnvironment({
        ...environment(),
        COMPOSE_PROJECT_NAME: project,
      }),
    ).toThrow();
    const value = container();
    value.Config.Labels["com.docker.compose.project"] =
      project as typeof PREVIEW.project;
    expect(() => validatePreviewContainer(value)).toThrow();
  });

  test.each([
    ["AGSAAS_DASHBOARD_URL", "http://localhost:3300"],
    ["AGSAAS_API_URL", "https://other.example"],
    ["SUPABASE_PUBLIC_URL", "http://localhost:3800"],
    ["API_EXTERNAL_URL", `${PREVIEW.supabase}/wrong`],
    ["DISABLE_SIGNUP", "false"],
    ["ENABLE_EMAIL_AUTOCONFIRM", "true"],
    ["AUTH_ENABLED_PROVIDERS", "email,password"],
    ["FUNCTIONS_VERIFY_JWT", "false"],
    ["COMPOSE_FILE", "docker-compose.yml:compose.mail-test.yml"],
    [
      "AGSAAS_DATABASE_URL",
      "postgresql://supabase_admin:fake@db:5432/postgres",
    ],
    ["POOLER_TENANT_ID", "agsaas-stage"],
  ])("rejects unsafe preview setting %s", (key, value) => {
    expect(() =>
      validatePreviewEnvironment({ ...environment(), [key]: value }),
    ).toThrow();
  });

  test("rejects data mounted from the original deployment", () => {
    const value = container();
    value.Mounts[0]!.Source = "/opt/agsaas/runtime/supabase/volumes/db/data";
    expect(() => validatePreviewContainer(value)).toThrow();
  });

  test("rejects a matching name backed by another image or working directory", () => {
    const image = container();
    image.Config.Image = "postgres:17" as typeof PREVIEW.image;
    expect(() => validatePreviewContainer(image)).toThrow();
    const directory = container();
    directory.Config.Labels["com.docker.compose.project.working_dir"] =
      "/tmp/other" as typeof PREVIEW.runtime;
    expect(() => validatePreviewContainer(directory)).toThrow();
  });

  test("rejects stopped or unhealthy databases", () => {
    const stopped = container();
    stopped.State.Running = false;
    expect(() => validatePreviewContainer(stopped)).toThrow();
    const unhealthy = container();
    unhealthy.State.Health.Status = "unhealthy";
    expect(() => validatePreviewContainer(unhealthy)).toThrow();
  });
});
