import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCleanVendorDocker,
  copyPublicPlatformSnapshot,
  installPublicOtpTemplate,
  parseEnvironment,
  SUPABASE_COMMIT,
  serializeEnvironment,
  validateGeneratedSecrets,
} from "./prepare-self-hosted.mts";
import {
  assertRehearsalAclMatches,
  compareRehearsalAclSnapshots,
  matchedExtensionRestoreSql,
  rehearsalAclMetadataSql,
  resetRehearsalDefaultAclSql,
} from "./rehearsal-acl.mts";
import {
  isTransactionControl,
  provisioningSql,
  sqlStatements,
  validateDatabaseEnvironment,
} from "./self-hosted-db.mts";

export const REHEARSAL = {
  root: "/opt/agsaas/rehearsal-20261101",
  source: "/opt/agsaas/rehearsal-20261101/source",
  runtime: "/opt/agsaas/rehearsal-20261101/runtime/supabase",
  backup: "/opt/agsaas/rehearsal-20261101/backup",
  project: "agsaas-rehearsal-20261101",
  originalRuntime: "/opt/agsaas/runtime/supabase",
  originalSource: "/opt/agsaas/source",
  originalProject: "agsaas-stage",
  vendor: "/opt/agsaas/vendor/supabase",
  postgresImage: "supabase/postgres:17.6.1.136",
  baselineSha256:
    "e999657a93946bc8de87cc3a9321757984cfe2e3b3491fa643be58f10b8b32fd",
} as const;

const DOCKER = ["--host", "unix:///var/run/docker.sock"];
const COPY_EXCL = constants.COPYFILE_EXCL;
type RecordValue = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Unexpected metadata shape; details suppressed");
  }
  return value as RecordValue;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail("Invalid private metadata; details suppressed");
  }
}

function command(executable: string, args: string[], input?: string): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    input,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    // Docker config, SQL errors and commands can contain credentials or row data.
    if (existsSync(REHEARSAL.runtime)) {
      writeFileSync(
        `${REHEARSAL.runtime}/command-private-diagnostics-${Date.now()}.log`,
        result.stderr ?? "",
        { flag: "wx", mode: 0o600 },
      );
    }
    fail(
      `Rehearsal command failed (${executable}, exit ${result.status}); output suppressed`,
    );
  }
  return result.stdout.trim();
}

function docker(args: string[], input?: string): string {
  return command("docker", [...DOCKER, ...args], input);
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    fail("A dedicated real directory is required; symlinks are forbidden");
  }
}

function readPrivate(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail("Private input must be a regular owner-only file");
  }
  return readFileSync(path, "utf8");
}

function writeNew(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sourceCommit(): string {
  if (
    command("git", [
      "-C",
      REHEARSAL.source,
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ])
  )
    fail("A clean dedicated source checkout is required");
  const revision = command("git", [
    "-C",
    REHEARSAL.source,
    "rev-parse",
    "HEAD",
  ]);
  if (!/^[a-f0-9]{40}$/.test(revision))
    fail("A full rehearsal source commit is required");
  return revision;
}

/** Change only the release of the stopped, separately owned rehearsal. */
export function retargetRehearsal(): RecordValue {
  assertDirectory(REHEARSAL.runtime);
  assertDirectory(REHEARSAL.source);
  inspectDatabase(false);
  const active = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${REHEARSAL.project}`,
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  ]);
  if (active !== "db")
    fail("Only the rehearsal database may run during retarget");
  const current = parseEnvironment(readPrivate(`${REHEARSAL.runtime}/.env`));
  const original = parseEnvironment(
    readPrivate(`${REHEARSAL.backup}/runtime.env`),
  );
  const previous = current.AGSAAS_RELEASE;
  if (!previous || !/^[a-f0-9]{40}$/.test(previous))
    fail("Invalid previous release");
  const expected = rehearsalEnvironment(original, previous);
  if (
    Object.keys(current).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, value]) => current[name] !== value)
  )
    fail("Rehearsal configuration changed; do not overwrite operator changes");
  for (const name of [
    "platform.compose.yml",
    "compose.mail-test.yml",
    "compose.apps.yml",
    "compose.rehearsal.yml",
  ]) {
    if (
      sha256(`${REHEARSAL.source}/deploy/self-hosted/${name}`) !==
      sha256(`${REHEARSAL.runtime}/${name}`)
    )
      fail(
        "Deployment layers changed; an explicit reviewed update is required",
      );
  }
  const revision = sourceCommit();
  if (revision === previous) return composeConfig();
  const backup = `${REHEARSAL.runtime}/env-before-${previous}-to-${revision}`;
  copyFileSync(`${REHEARSAL.runtime}/.env`, backup, COPY_EXCL);
  chmodSync(backup, 0o600);
  const next = `${REHEARSAL.runtime}/env-next-${revision}`;
  writeFileSync(
    next,
    serializeEnvironment(rehearsalEnvironment(original, revision)),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  renameSync(next, `${REHEARSAL.runtime}/.env`);
  return { previous, revision, ...composeConfig() };
}

export function rehearsalEnvironment(
  original: Record<string, string>,
  revision: string,
): Record<string, string> {
  validateDatabaseEnvironment(original);
  validateGeneratedSecrets(original);
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("Invalid rehearsal revision");
  return {
    ...original,
    COMPOSE_PROJECT_NAME: REHEARSAL.project,
    COMPOSE_FILE:
      "docker-compose.yml:platform.compose.yml:compose.mail-test.yml:compose.apps.yml:compose.rehearsal.yml",
    AGSAAS_SOURCE_DIR: REHEARSAL.source,
    AGSAAS_RELEASE: revision,
    AGSAAS_DASHBOARD_URL: "http://127.0.0.1:3400",
    AGSAAS_API_URL: "http://127.0.0.1:3403",
    SUPABASE_PUBLIC_URL: "http://127.0.0.1:3900",
    API_EXTERNAL_URL: "http://127.0.0.1:3900/auth/v1",
    API_GW_HTTP_PORT: "127.0.0.1:3900",
    SITE_URL: "http://127.0.0.1:3400",
    ADDITIONAL_REDIRECT_URLS: "http://127.0.0.1:3400/api/auth/callback",
    POOLER_TENANT_ID: REHEARSAL.project,
    STORAGE_TENANT_ID: REHEARSAL.project,
    GLOBAL_S3_BUCKET: REHEARSAL.project,
    AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.${REHEARSAL.project}:${original.AGSAAS_DB_PASSWORD}@supavisor:6543/postgres?sslmode=disable`,
    SELF_HOSTED_SMOKE_MAILPIT_URL: "http://127.0.0.1:3925",
    STUDIO_DEFAULT_PROJECT: "AGSaaS isolated restore rehearsal",
    SMTP_HOST: "mailpit",
    SMTP_PORT: "1025",
    SMTP_USER: "",
    SMTP_PASS: "",
    ENABLE_EMAIL_AUTOCONFIRM: "false",
    ENABLE_PHONE_AUTOCONFIRM: "false",
    OPENAI_API_KEY: "",
    AGSAAS_WORKER_ENV: "staging",
    INSIGHTS_ENABLED: "false",
  };
}

/** Inspect only non-secret fields; never return Docker's Config.Env. */
function inspectDatabase(original: boolean): { id: string; imageId: string } {
  const project = original ? REHEARSAL.originalProject : REHEARSAL.project;
  const runtime = original ? REHEARSAL.originalRuntime : REHEARSAL.runtime;
  const result = json(
    docker([
      "inspect",
      `${project}-db`,
      "--format",
      "{{json .Id}}|{{json .Config.Image}}|{{json .Image}}|{{json .Name}}|{{json .State.Running}}|{{json .Config.Labels}}|{{json .Mounts}}",
    ])
      .split("|")
      .map((part) => part.trim())
      .join(",")
      .replace(/^/, "[")
      .replace(/$/, "]"),
  );
  if (!Array.isArray(result)) fail("Invalid database inspection");
  const [id, image, imageId, name, running, labelsValue, mounts] = result;
  const labels = object(labelsValue);
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{64}$/.test(id) ||
    image !== REHEARSAL.postgresImage ||
    name !== `/${project}-db` ||
    running !== true ||
    labels["com.docker.compose.project"] !== project ||
    labels["com.docker.compose.service"] !== "db" ||
    labels["com.docker.compose.project.working_dir"] !== runtime ||
    typeof imageId !== "string" ||
    !Array.isArray(mounts)
  ) {
    fail("Database identity does not match the dedicated matched stack");
  }
  const data = mounts
    .map(object)
    .filter((mount) => mount.Destination === "/var/lib/postgresql/data");
  if (
    data.length !== 1 ||
    data[0]?.Type !== "bind" ||
    data[0]?.Source !== `${runtime}/volumes/db/data` ||
    data[0]?.RW !== true
  ) {
    fail("Unexpected database data mount");
  }
  assertDirectory(runtime);
  assertDirectory(`${runtime}/volumes/db/data`);
  for (const raw of mounts) {
    const mount = object(raw);
    if (mount.Type === "bind") {
      if (
        typeof mount.Source !== "string" ||
        !mount.Source.startsWith(`${runtime}/`) ||
        realpathSync(mount.Source) !== mount.Source
      ) {
        fail("Database bind mount has an unexpected canonical path");
      }
    } else if (mount.Type === "volume") {
      if (mount.Name !== `${project}_db-config` || mount.Driver !== "local") {
        fail("Unexpected database configuration volume");
      }
      const records = json(docker(["volume", "inspect", String(mount.Name)]));
      if (!Array.isArray(records) || records.length !== 1)
        fail("Invalid volume inspection");
      const volume = object(records[0]);
      if (
        volume.Driver !== "local" ||
        (volume.Options !== null &&
          Object.keys(object(volume.Options)).length !== 0) ||
        object(volume.Labels)["com.docker.compose.project"] !== project
      ) {
        fail("Database configuration volume must not alias another filesystem");
      }
    } else fail("Unexpected database mount type");
  }
  return { id, imageId };
}

function psql(
  id: string,
  sql: string,
  transaction = false,
  administrator = false,
): string {
  if (administrator && inspectDatabase(false).id !== id)
    fail("Administrative SQL is restricted to the verified rehearsal database");
  return docker(
    [
      "exec",
      "--interactive",
      id,
      "timeout",
      "-k",
      "5s",
      "50s",
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--username",
      administrator ? "supabase_admin" : "postgres",
      "--host",
      "/var/run/postgresql",
      "--port",
      "5432",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      ...(transaction ? ["--single-transaction"] : []),
    ],
    sql,
  );
}

const INVENTORY_SQL = `SELECT json_build_object(
  'users', (SELECT count(*) FROM public.users),
  'teams', (SELECT count(*) FROM public.teams),
  'invoices', (SELECT count(*) FROM public.invoices),
  'transactions', (SELECT count(*) FROM public.transactions),
  'storageObjects', (SELECT count(*) FROM storage.objects),
  'baseline', (SELECT sha256 FROM private.agsaas_baseline_installation
    WHERE version = '20261031154237'),
  'migrations', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
);`;

function inventory(id: string): RecordValue {
  const value = object(json(psql(id, INVENTORY_SQL)));
  if (value.baseline !== REHEARSAL.baselineSha256)
    fail("The installed baseline does not match");
  return value;
}

function securityMetadata(id: string): unknown {
  return json(psql(id, rehearsalAclMetadataSql()));
}

function restoreSecuritySnapshot(backup: RecordValue): unknown {
  const path = `${REHEARSAL.backup}/security-snapshot.json`;
  if (!existsSync(path)) {
    // Compatibility with the first drill snapshot, captured before ACL drift
    // was discovered. This is an explicitly labelled later metadata snapshot,
    // never a claim that permissions were captured with the original data dump.
    const original = inspectDatabase(true);
    if (
      original.id !== backup.sourceContainerId ||
      JSON.stringify(inventory(original.id)) !==
        JSON.stringify(backup.inventory) ||
      command("git", ["-C", REHEARSAL.originalSource, "rev-parse", "HEAD"]) !==
        backup.originalSourceCommit
    )
      fail(
        "Source changed; cannot supplement the old backup with permission metadata",
      );
    writeNew(path, {
      captureMode: "supplemental-after-data-snapshot",
      capturedAt: new Date().toISOString(),
      sourceContainerId: original.id,
      sourceCommit: backup.originalSourceCommit,
      metadata: securityMetadata(original.id),
    });
  }
  if (
    backup.securitySnapshotSha256 &&
    backup.securitySnapshotSha256 !== sha256(path)
  )
    fail("Security snapshot digest mismatch");
  const snapshot = object(json(readPrivate(path)));
  if (
    snapshot.sourceContainerId !== backup.sourceContainerId ||
    snapshot.sourceCommit !== backup.originalSourceCommit ||
    !snapshot.metadata
  )
    fail("Security snapshot identity mismatch");
  return snapshot.metadata;
}

function capture(args: string[], destination: string): void {
  const fd = openSync(destination, "wx", 0o600);
  try {
    const result = spawnSync("docker", [...DOCKER, ...args], {
      timeout: 60_000,
      stdio: ["ignore", fd, "pipe"],
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0)
      fail(
        "Backup failed; partial private artifacts retained, not marked complete",
      );
  } finally {
    closeSync(fd);
  }
}

export function prepareRehearsal(): RecordValue {
  assertDirectory(REHEARSAL.root);
  assertDirectory(REHEARSAL.source);
  assertDirectory(REHEARSAL.vendor);
  if (existsSync(REHEARSAL.runtime))
    fail("Rehearsal runtime already exists; no overwrite or key rotation");
  if (
    command("git", ["-C", REHEARSAL.vendor, "rev-parse", "HEAD"]) !==
    SUPABASE_COMMIT
  ) {
    fail("The vendor revision differs from the matched release");
  }
  assertCleanVendorDocker(REHEARSAL.vendor);
  inspectDatabase(true);
  const original = parseEnvironment(
    readPrivate(`${REHEARSAL.originalRuntime}/.env`),
  );
  const revision = sourceCommit();
  const values = rehearsalEnvironment(original, revision);
  mkdirSync(`${REHEARSAL.root}/runtime`, { mode: 0o700 });
  copyPublicPlatformSnapshot(REHEARSAL.vendor, REHEARSAL.runtime);
  // These keys belong to this owner's restore drill and never leave the host.
  // Reusing cryptographic material allows restored encrypted records to be read.
  writeFileSync(`${REHEARSAL.runtime}/.env`, serializeEnvironment(values), {
    flag: "wx",
    mode: 0o600,
  });
  for (const file of [
    "platform.compose.yml",
    "compose.mail-test.yml",
    "compose.apps.yml",
    "compose.rehearsal.yml",
  ]) {
    copyFileSync(
      file === "compose.rehearsal.yml"
        ? fileURLToPath(
            new URL(
              "../deploy/self-hosted/compose.rehearsal.yml",
              import.meta.url,
            ),
          )
        : `${REHEARSAL.source}/deploy/self-hosted/${file}`,
      `${REHEARSAL.runtime}/${file}`,
      COPY_EXCL,
    );
    chmodSync(`${REHEARSAL.runtime}/${file}`, 0o644);
  }
  installPublicOtpTemplate(REHEARSAL.source, REHEARSAL.runtime);
  const report = {
    mode: "private-rehearsal",
    sourceCommit: revision,
    supabaseCommit: SUPABASE_COMMIT,
    project: REHEARSAL.project,
    publicAccessEnabled: false,
    externalEmailDeliveryEnabled: false,
    providerEgressEnabled: false,
    originalProjectUnchanged: true,
  };
  writeNew(`${REHEARSAL.runtime}/rehearsal-manifest.json`, report);
  return report;
}

export function validateRehearsalCompose(
  value: unknown,
  revision: string,
): string[] {
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("Invalid expected release");
  const config = object(value);
  if (config.name !== REHEARSAL.project) fail("Unexpected Compose project");
  const services = object(config.services);
  const expected = [
    "api",
    "api-gw",
    "auth",
    "dashboard",
    "db",
    "functions",
    "imgproxy",
    "mailpit",
    "meta",
    "realtime",
    "redis-cache",
    "redis-queue",
    "rest",
    "storage",
    "studio",
    "supavisor",
    "templates-server",
    "worker",
  ].sort();
  if (Object.keys(services).sort().join() !== expected.join())
    fail("Unexpected rehearsal service inventory");
  const ports = new Map<string, [number, number]>([
    ["api", [3403, 8080]],
    ["dashboard", [3400, 3000]],
    ["api-gw", [3900, 8000]],
    ["mailpit", [3925, 8025]],
  ]);
  for (const [service, raw] of Object.entries(services)) {
    const item = object(raw);
    if (
      typeof item.container_name === "string" &&
      !item.container_name.startsWith(`${REHEARSAL.project}-`) &&
      item.container_name !== `realtime-dev.${REHEARSAL.project}-realtime`
    ) {
      fail("A rehearsal container could collide with an existing project");
    }
    if (item.privileged || item.network_mode || item.pid || item.ipc === "host")
      fail("Unexpected host access");
    const networks = object(item.networks);
    if (Object.keys(networks).join() !== "default")
      fail("Unexpected egress network");
    const published = item.ports ?? [];
    if (!Array.isArray(published)) fail("Invalid ports");
    const required = ports.get(service);
    if (published.length !== (required ? 1 : 0))
      fail("Unexpected published port count");
    if (required) {
      const port = object(published[0]);
      if (
        port.host_ip !== "127.0.0.1" ||
        String(port.published) !== String(required[0]) ||
        Number(port.target) !== required[1] ||
        port.protocol !== "tcp"
      )
        fail("Only the dedicated loopback ports may be published");
    }
    for (const volume of (item.volumes ?? []) as unknown[]) {
      const mount = object(volume);
      if (mount.type === "bind") {
        if (
          typeof mount.source !== "string" ||
          !mount.source.startsWith(`${REHEARSAL.runtime}/`) ||
          resolve(mount.source) !== mount.source ||
          String(mount.target).includes("docker.sock")
        )
          fail("Unsafe rehearsal bind mount");
      } else if (
        mount.type !== "volume" ||
        !Object.hasOwn(object(config.volumes), String(mount.source))
      ) {
        fail("Unowned rehearsal volume");
      }
    }
    if (["api", "worker", "dashboard"].includes(service)) {
      if (
        item.image !== `agsaas-${service}:rehearsal-${revision}` ||
        object(item.build).context !== REHEARSAL.source ||
        object(object(item.build).args).GIT_COMMIT_SHA !== revision
      )
        fail("Application image/source could overwrite the active stage");
    }
  }
  const networks = object(config.networks);
  if (
    Object.keys(networks).join() !== "default" ||
    object(networks.default).internal !== true ||
    object(networks.default).external === true ||
    object(networks.default).name !== `${REHEARSAL.project}_default`
  ) {
    fail("The rehearsal network must be project-owned and internal");
  }
  for (const [name, raw] of Object.entries(object(config.volumes))) {
    const volume = object(raw);
    if (
      volume.external === true ||
      volume.name !== `${REHEARSAL.project}_${name}` ||
      volume.driver_opts !== undefined ||
      (volume.driver !== undefined && volume.driver !== "local")
    )
      fail("Unexpected external volume");
  }
  return expected;
}

function composeConfig(): RecordValue {
  assertDirectory(REHEARSAL.runtime);
  assertDirectory(REHEARSAL.source);
  const revision = sourceCommit();
  const env = parseEnvironment(readPrivate(`${REHEARSAL.runtime}/.env`));
  if (
    env.AGSAAS_RELEASE !== revision ||
    env.COMPOSE_PROJECT_NAME !== REHEARSAL.project ||
    env.AGSAAS_SOURCE_DIR !== REHEARSAL.source
  )
    fail("Checkout and rehearsal environment release must match exactly");
  const config = json(
    docker([
      "compose",
      "--project-directory",
      REHEARSAL.runtime,
      "--env-file",
      `${REHEARSAL.runtime}/.env`,
      ...[
        "docker-compose.yml",
        "platform.compose.yml",
        "compose.mail-test.yml",
        "compose.apps.yml",
        "compose.rehearsal.yml",
      ].flatMap((name) => ["--file", `${REHEARSAL.runtime}/${name}`]),
      "--project-name",
      REHEARSAL.project,
      "config",
      "--format",
      "json",
    ]),
  );
  return {
    project: REHEARSAL.project,
    services: validateRehearsalCompose(config, revision),
    isolated: true,
  };
}

export function snapshotOriginal(): RecordValue {
  assertDirectory(REHEARSAL.root);
  if (existsSync(REHEARSAL.backup))
    fail("Backup directory already exists; refuse overwrite");
  const database = inspectDatabase(true);
  const before = inventory(database.id);
  const securityBefore = securityMetadata(database.id);
  // This bounded drill supports the observed stage with no stored objects.
  // Nonempty Storage needs a separately coordinated write-quiescence snapshot.
  if (before.storageObjects !== 0)
    fail(
      "Storage is nonempty; a coordinated write-quiescence backup is required",
    );
  mkdirSync(REHEARSAL.backup, { mode: 0o700 });
  copyFileSync(
    `${REHEARSAL.originalRuntime}/.env`,
    `${REHEARSAL.backup}/runtime.env`,
    COPY_EXCL,
  );
  chmodSync(`${REHEARSAL.backup}/runtime.env`, 0o600);
  capture(
    [
      "exec",
      database.id,
      "timeout",
      "-k",
      "5s",
      "50s",
      "pg_dump",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--format",
      "custom",
      "--host",
      "/var/run/postgresql",
      "--port",
      "5432",
      "--lock-wait-timeout",
      "5000",
    ],
    `${REHEARSAL.backup}/postgres.dump`,
  );
  capture(
    [
      "exec",
      database.id,
      "tar",
      "-C",
      "/etc/postgresql-custom",
      "-czf",
      "-",
      ".",
    ],
    `${REHEARSAL.backup}/db-config.tgz`,
  );
  const after = inventory(database.id);
  if (JSON.stringify(before) !== JSON.stringify(after))
    fail(
      "Source inventory changed during backup; retained artifacts are not marked complete",
    );
  assertRehearsalAclMatches(securityBefore, securityMetadata(database.id));
  writeNew(`${REHEARSAL.backup}/security-snapshot.json`, {
    captureMode: "checked-before-and-after-data-snapshot",
    capturedAt: new Date().toISOString(),
    sourceContainerId: database.id,
    sourceCommit: command("git", [
      "-C",
      REHEARSAL.originalSource,
      "rev-parse",
      "HEAD",
    ]),
    metadata: securityBefore,
  });
  if (statSync(`${REHEARSAL.backup}/postgres.dump`).size < 1024)
    fail("Unexpectedly small database backup");
  const manifest = {
    mode: "same-host-restore-drill",
    capturedAt: new Date().toISOString(),
    originalSourceCommit: command("git", [
      "-C",
      REHEARSAL.originalSource,
      "rev-parse",
      "HEAD",
    ]),
    sourceContainerId: database.id,
    postgresImageId: database.imageId,
    databaseSha256: sha256(`${REHEARSAL.backup}/postgres.dump`),
    dbConfigSha256: sha256(`${REHEARSAL.backup}/db-config.tgz`),
    pgsodiumKeySha256: docker([
      "exec",
      database.id,
      "sha256sum",
      "/etc/postgresql-custom/pgsodium_root.key",
    ]).split(/\s+/)[0],
    pgsodiumKeyMetadata: docker([
      "exec",
      database.id,
      "stat",
      "-c",
      "%u:%g:%a:%s",
      "/etc/postgresql-custom/pgsodium_root.key",
    ]),
    runtimeEnvSha256: sha256(`${REHEARSAL.backup}/runtime.env`),
    securitySnapshotSha256: sha256(
      `${REHEARSAL.backup}/security-snapshot.json`,
    ),
    inventory: before,
    storageObjectsEmpty: true,
    offHostBackup: false,
  };
  writeNew(`${REHEARSAL.backup}/manifest.json`, manifest);
  return manifest;
}

export function validateArchiveEntries(names: string, details: string): void {
  const paths = names.trim().split(/\r?\n/);
  const records = details.trim().split(/\r?\n/);
  if (
    !names.trim() ||
    records.length !== paths.length ||
    paths.some(
      (path) =>
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        !/^\.\/(?:[A-Za-z0-9_.-]+\/?)*$/.test(path),
    ) ||
    records.some((line) => !/^[d-][rwxstST-]{9}\s/.test(line))
  ) {
    fail(
      "Database config archive must contain only safe regular files/directories",
    );
  }
  const keyIndex = paths.indexOf("./pgsodium_root.key");
  if (keyIndex < 0 || !records[keyIndex]?.startsWith("-")) {
    fail("Database config backup lacks the pgsodium root key");
  }
}

export function seedRehearsalConfig(): RecordValue {
  composeConfig();
  const backup = object(json(readPrivate(`${REHEARSAL.backup}/manifest.json`)));
  if (backup.dbConfigSha256 !== sha256(`${REHEARSAL.backup}/db-config.tgz`)) {
    fail("Database config archive checksum mismatch");
  }
  const volumeName = `${REHEARSAL.project}_db-config`;
  if (
    docker([
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${REHEARSAL.project}`,
      "--quiet",
    ])
  ) {
    fail("Seed configuration before creating any rehearsal container");
  }
  if (docker(["volume", "ls", "--quiet", "--filter", `name=^${volumeName}$`])) {
    fail(
      "Rehearsal database configuration volume already exists; refuse overwrite",
    );
  }
  const image = docker([
    "image",
    "inspect",
    "alpine:3.21",
    "--format",
    "{{.Id}}",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    fail("An already installed archive utility image is required");
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--memory",
    "64m",
    "--pids-limit",
    "32",
    "--cpus",
    "0.25",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--mount",
    `type=bind,source=${REHEARSAL.backup}/db-config.tgz,target=/backup.tgz,readonly`,
  ];
  const names = docker([...args, image, "tar", "-tzf", "/backup.tgz"]);
  const details = docker([...args, image, "tar", "-tvzf", "/backup.tgz"]);
  validateArchiveEntries(names, details);
  docker([
    "volume",
    "create",
    "--driver",
    "local",
    "--label",
    `com.docker.compose.project=${REHEARSAL.project}`,
    "--label",
    "com.docker.compose.volume=db-config",
    volumeName,
  ]);
  // The exact newly created empty volume is the only writable mount. Archive
  // entries have no symlinks, links, devices, absolute paths or path traversal.
  docker([
    ...args,
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "DAC_OVERRIDE",
    "--mount",
    `type=volume,source=${volumeName},target=/target`,
    image,
    "tar",
    "-xzpf",
    "/backup.tgz",
    "-C",
    "/target",
  ]);
  const keyMetadata = String(backup.pgsodiumKeyMetadata);
  if (
    !/^\d+:\d+:[0-7]{3}:\d+$/.test(keyMetadata) ||
    Number(keyMetadata.split(":")[3]) === 0
  ) {
    fail("Invalid saved database key ownership metadata");
  }
  const targetArgs = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--memory",
    "64m",
    "--pids-limit",
    "32",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--user",
    keyMetadata.split(":").slice(0, 2).join(":"),
    "--mount",
    `type=volume,source=${volumeName},target=/target,readonly`,
    image,
  ];
  const targetDigest = docker([
    ...targetArgs,
    "sha256sum",
    "/target/pgsodium_root.key",
  ]).split(/\s+/)[0];
  const targetMetadata = docker([
    ...targetArgs,
    "stat",
    "-c",
    "%u:%g:%a:%s",
    "/target/pgsodium_root.key",
  ]);
  if (
    targetDigest !== backup.pgsodiumKeySha256 ||
    targetMetadata !== backup.pgsodiumKeyMetadata
  ) {
    fail(
      "Restored pgsodium key digest, ownership or mode does not match the backup",
    );
  }
  const report = {
    project: REHEARSAL.project,
    seeded: true,
    dbConfigSha256: backup.dbConfigSha256,
    archiveImageId: image,
    pgsodiumRootKeyPreserved: true,
    pgsodiumKeySha256: targetDigest,
  };
  writeNew(`${REHEARSAL.runtime}/config-seed-result.json`, report);
  return report;
}

export function restoreRehearsal(
  repair = false,
  resumePartitions = false,
): RecordValue {
  composeConfig();
  const database = inspectDatabase(false);
  const backup = object(json(readPrivate(`${REHEARSAL.backup}/manifest.json`)));
  const seed = object(
    json(readPrivate(`${REHEARSAL.runtime}/config-seed-result.json`)),
  );
  if (
    backup.postgresImageId !== database.imageId ||
    backup.databaseSha256 !== sha256(`${REHEARSAL.backup}/postgres.dump`) ||
    backup.runtimeEnvSha256 !== sha256(`${REHEARSAL.backup}/runtime.env`) ||
    backup.storageObjectsEmpty !== true ||
    seed.dbConfigSha256 !== backup.dbConfigSha256 ||
    seed.seeded !== true ||
    seed.pgsodiumRootKeyPreserved !== true ||
    seed.pgsodiumKeySha256 !== backup.pgsodiumKeySha256 ||
    docker([
      "exec",
      database.id,
      "sha256sum",
      "/etc/postgresql-custom/pgsodium_root.key",
    ]).split(/\s+/)[0] !== backup.pgsodiumKeySha256
  )
    fail("Backup identity or digest mismatch");
  const proofPath = `${REHEARSAL.runtime}/restore-result.json`;
  if (!repair && existsSync(proofPath))
    fail("A restore is already recorded; refuse to replace the database");
  if (repair) {
    // A single, explicit recovery for the first legacy proof, which checked
    // data inventory but not effective ACLs. Preserve both its proof and the
    // current disposable database before replacing anything. No generic reset.
    const proof = object(json(readPrivate(proofPath)));
    if (
      proof.project !== REHEARSAL.project ||
      proof.restored !== true ||
      proof.permissionsVerified === true ||
      proof.databaseSha256 !== backup.databaseSha256 ||
      JSON.stringify(object(backup.inventory).migrations) !==
        '["20261031154237"]' ||
      JSON.stringify(proof.inventory) !== JSON.stringify(backup.inventory) ||
      JSON.stringify(inventory(database.id)) !==
        JSON.stringify(backup.inventory) ||
      existsSync(`${REHEARSAL.runtime}/acl-repair-attempt.json`) !==
        resumePartitions
    )
      fail("Only the unchanged first baseline restore may undergo ACL repair");
  }
  const active = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${REHEARSAL.project}`,
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  ]);
  if (active !== "db")
    fail("Only the rehearsal database may run during restoration");
  if (
    !repair &&
    psql(database.id, "SELECT to_regclass('public.users') IS NOT NULL;") !== "f"
  )
    fail("The rehearsal database already has application data");
  const values = parseEnvironment(readPrivate(`${REHEARSAL.runtime}/.env`));
  // This NOLOGIN ownership role is created by the matched Realtime service,
  // not by the base Postgres image. Restore its exact observed safe attributes
  // before pg_restore encounters ownership/ACL statements. Never copy passwords
  // or infer arbitrary missing roles from an error string.
  const realtimeRoleQuery = `SELECT json_build_object(
    'login',rolcanlogin,'superuser',rolsuper,'createDb',rolcreatedb,
    'createRole',rolcreaterole,'inherit',rolinherit,'bypassRls',rolbypassrls,
    'replication',rolreplication,'connectionLimit',rolconnlimit,
    'validUntil',rolvaliduntil,'config',rolconfig,
    'memberships',(SELECT json_agg(json_build_object('role',parent.rolname,'admin',member.admin_option) ORDER BY parent.rolname)
      FROM pg_auth_members member JOIN pg_roles parent ON parent.oid=member.roleid WHERE member.member=r.oid)
  ) FROM pg_roles r WHERE rolname='supabase_realtime_admin';`;
  const rolesPath = `${REHEARSAL.backup}/realtime-role.json`;
  const roleSnapshot = existsSync(rolesPath)
    ? json(readPrivate(rolesPath))
    : json(psql(inspectDatabase(true).id, realtimeRoleQuery));
  const realtimeSql = realtimeRoleRestoreSql(roleSnapshot);
  if (!existsSync(rolesPath)) writeNew(rolesPath, roleSnapshot);
  const currentRealtime = psql(database.id, realtimeRoleQuery);
  if (!currentRealtime) psql(database.id, realtimeSql, true, true);
  else realtimeRoleRestoreSql(json(currentRealtime));
  const roleState = psql(
    database.id,
    "SELECT CASE WHEN rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit AND NOT rolreplication THEN 'safe' ELSE 'unsafe' END FROM pg_roles WHERE rolname='agsaas_app';",
  );
  if (!roleState)
    // A non-superuser CREATE ROLE also adds a creator ADMIN membership in PG17.
    // The original bootstrap used the built-in administrator; match that here.
    psql(database.id, provisioningSql(values.AGSAAS_DB_PASSWORD!), true, true);
  else if (roleState !== "safe")
    fail("Unexpected preexisting application role in the rehearsal");
  const expectedSecurity = restoreSecuritySnapshot(backup);
  if (repair && !resumePartitions) {
    const beforeSecurity = securityMetadata(database.id);
    const roleDifferences = compareRehearsalAclSnapshots(
      expectedSecurity,
      beforeSecurity,
    ).filter((difference) => difference.section !== "objects");
    const creatorMembership =
      '["membership", "agsaas_app", "postgres", "supabase_admin"]';
    if (
      roleDifferences.length !== 1 ||
      roleDifferences[0]?.section !== "memberships" ||
      roleDifferences[0]?.key !== creatorMembership ||
      roleDifferences[0]?.change !== "added"
    )
      fail(
        "Legacy restore role state differs from the single observed creator grant",
      );
    capture(
      [
        "exec",
        database.id,
        "timeout",
        "-k",
        "5s",
        "50s",
        "pg_dump",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--format",
        "custom",
        "--host",
        "/var/run/postgresql",
        "--port",
        "5432",
        "--lock-wait-timeout",
        "5000",
      ],
      `${REHEARSAL.backup}/rehearsal-before-acl-repair.dump`,
    );
    copyFileSync(
      proofPath,
      `${REHEARSAL.runtime}/restore-before-acl-repair.json`,
      COPY_EXCL,
    );
    chmodSync(`${REHEARSAL.runtime}/restore-before-acl-repair.json`, 0o600);
    writeNew(
      `${REHEARSAL.backup}/security-before-acl-repair.json`,
      beforeSecurity,
    );
    writeNew(`${REHEARSAL.runtime}/acl-repair-attempt.json`, {
      startedAt: new Date().toISOString(),
      project: REHEARSAL.project,
      databaseSha256: sha256(
        `${REHEARSAL.backup}/rehearsal-before-acl-repair.dump`,
      ),
      securitySha256: sha256(
        `${REHEARSAL.backup}/security-before-acl-repair.json`,
      ),
    });
    psql(
      database.id,
      `DO $agsaas_legacy_creator_grant$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    JOIN pg_roles grantor ON grantor.oid = m.grantor
    WHERE parent.rolname = 'agsaas_app' AND member.rolname = 'postgres'
      AND grantor.rolname = 'supabase_admin'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
  ) THEN
    RAISE EXCEPTION 'Unexpected legacy creator membership; no privilege repair performed';
  END IF;
  REVOKE agsaas_app FROM postgres GRANTED BY supabase_admin RESTRICT;
END
$agsaas_legacy_creator_grant$;`,
      true,
      true,
    );
  }
  if (resumePartitions) {
    // The first pg_restore --clean transaction rolled back on an inherited
    // Realtime partition constraint. Do not weaken exit-on-error or edit the
    // dump's TOC. One explicit resume may remove only the parent primary key
    // with RESTRICT, after preserving the original clone and role metadata.
    // Its internally owned child PKs are removed automatically; no table or
    // row is deleted, and external dependencies cause a failure, not CASCADE.
    const attempt = object(
      json(readPrivate(`${REHEARSAL.runtime}/acl-repair-attempt.json`)),
    );
    if (
      !repair ||
      attempt.project !== REHEARSAL.project ||
      attempt.databaseSha256 !==
        sha256(`${REHEARSAL.backup}/rehearsal-before-acl-repair.dump`) ||
      attempt.securitySha256 !==
        sha256(`${REHEARSAL.backup}/security-before-acl-repair.json`) ||
      existsSync(`${REHEARSAL.runtime}/partition-restore-resume.json`)
    )
      fail("Invalid or already consumed partition-restore recovery proof");
    const diagnostics = readdirSync(REHEARSAL.runtime)
      .filter((name) => /^restore-private-diagnostics-\d+\.log$/.test(name))
      .sort();
    const lastDiagnostic = diagnostics.at(-1);
    if (
      !lastDiagnostic ||
      !/ERROR: {2}cannot drop inherited constraint "messages_\d{4}_\d{2}_\d{2}_pkey" of relation "messages_\d{4}_\d{2}_\d{2}"/.test(
        readPrivate(`${REHEARSAL.runtime}/${lastDiagnostic}`),
      )
    )
      fail(
        "Partition recovery is restricted to the observed inherited-constraint failure",
      );
    const remaining = compareRehearsalAclSnapshots(
      expectedSecurity,
      securityMetadata(database.id),
    ).filter((difference) => difference.section !== "objects");
    const expectedDefaults = object(expectedSecurity).defaultPrivileges;
    if (
      !Array.isArray(expectedDefaults) ||
      remaining.length !== expectedDefaults.length ||
      remaining.some(
        (difference) =>
          difference.section !== "defaultPrivileges" ||
          difference.change !== "removed",
      )
    )
      fail("Unexpected role/default state after the rolled-back restore");
    writeNew(`${REHEARSAL.runtime}/partition-restore-resume.json`, {
      startedAt: new Date().toISOString(),
      project: REHEARSAL.project,
      sourceFailure: lastDiagnostic,
      backupSha256: backup.databaseSha256,
    });
    psql(
      database.id,
      `SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
LOCK TABLE realtime.messages IN ACCESS EXCLUSIVE MODE;
DO $empty_realtime_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM realtime.messages LIMIT 1) THEN
    RAISE EXCEPTION 'Realtime messages are not empty; no partition recovery performed';
  END IF;
END
$empty_realtime_guard$;
ALTER TABLE realtime.messages DROP CONSTRAINT messages_pkey RESTRICT;`,
      true,
      true,
    );
  }
  // pg_restore replays object ACLs relative to PostgreSQL's built-in defaults.
  // It does not remove Supabase's pre-existing schema-local default grants.
  // Normalize ONLY the verified target; the dump reinstates source defaults.
  psql(database.id, resetRehearsalDefaultAclSql(), true, true);
  const fd = openSync(`${REHEARSAL.backup}/postgres.dump`, "r");
  try {
    const result = spawnSync(
      "docker",
      [
        ...DOCKER,
        "exec",
        "--interactive",
        database.id,
        "timeout",
        "-k",
        "5s",
        "50s",
        "pg_restore",
        "--username",
        // Supabase's postgres role is deliberately not a superuser. Restoring
        // managed Auth/event-trigger ownership needs the built-in administrator
        // in this verified disposable target, never in the source stage.
        "supabase_admin",
        "--dbname",
        "postgres",
        "--single-transaction",
        "--exit-on-error",
        "--clean",
        "--if-exists",
        "--host",
        "/var/run/postgresql",
        "--port",
        "5432",
      ],
      {
        stdio: [fd, "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      writeFileSync(
        `${REHEARSAL.runtime}/restore-private-diagnostics-${Date.now()}.log`,
        result.stderr ?? "",
        { flag: "wx", mode: 0o600 },
      );
      fail(
        "Restore failed or completion is uncertain; original database untouched, inspect rehearsal before retrying",
      );
    }
  } finally {
    closeSync(fd);
  }
  return verifyRestoredCopy(database, backup, expectedSecurity, repair);
}

function verifyRestoredCopy(
  database: { id: string; imageId: string },
  backup: RecordValue,
  expectedSecurity: unknown,
  repair: boolean,
): RecordValue {
  const extensionSql = matchedExtensionRestoreSql(
    expectedSecurity,
    securityMetadata(database.id),
  );
  if (extensionSql) psql(database.id, extensionSql, true, true);
  const restored = inventory(database.id);
  if (JSON.stringify(restored) !== JSON.stringify(backup.inventory))
    fail("Restored inventory does not match the snapshot");
  const actualSecurity = securityMetadata(database.id);
  const differences = compareRehearsalAclSnapshots(
    expectedSecurity,
    actualSecurity,
  );
  writeNew(`${REHEARSAL.runtime}/security-restore-check-${Date.now()}.json`, {
    expected: expectedSecurity,
    actual: actualSecurity,
    differences,
  });
  assertRehearsalAclMatches(expectedSecurity, actualSecurity);
  const report = {
    restored: true,
    project: REHEARSAL.project,
    databaseSha256: backup.databaseSha256,
    inventory: restored,
    originalProjectUnchanged: true,
    realtimeRoleRestored: true,
    permissionsVerified: true,
    securitySnapshotSha256: sha256(
      `${REHEARSAL.backup}/security-snapshot.json`,
    ),
    repairedLegacyRestore: repair,
  };
  if (repair) {
    const nextProof = `${REHEARSAL.runtime}/restore-acl-repaired.json`;
    writeNew(nextProof, report);
    renameSync(nextProof, `${REHEARSAL.runtime}/restore-result.json`);
  } else writeNew(`${REHEARSAL.runtime}/restore-result.json`, report);
  return report;
}

/** Complete the exact already-restored copy, never execute another restore. */
export function finalizeMatchedExtensionRestore(): RecordValue {
  composeConfig();
  const database = inspectDatabase(false);
  const backup = object(json(readPrivate(`${REHEARSAL.backup}/manifest.json`)));
  const prior = object(
    json(readPrivate(`${REHEARSAL.runtime}/restore-result.json`)),
  );
  const resume = object(
    json(readPrivate(`${REHEARSAL.runtime}/partition-restore-resume.json`)),
  );
  const active = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${REHEARSAL.project}`,
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  ]);
  if (
    active !== "db" ||
    prior.project !== REHEARSAL.project ||
    prior.permissionsVerified === true ||
    prior.databaseSha256 !== backup.databaseSha256 ||
    resume.project !== REHEARSAL.project ||
    resume.backupSha256 !== backup.databaseSha256 ||
    database.imageId !== backup.postgresImageId ||
    sha256(`${REHEARSAL.backup}/postgres.dump`) !== backup.databaseSha256 ||
    JSON.stringify(inventory(database.id)) !==
      JSON.stringify(backup.inventory) ||
    docker([
      "exec",
      database.id,
      "sha256sum",
      "/etc/postgresql-custom/pgsodium_root.key",
    ]).split(/\s+/)[0] !== backup.pgsodiumKeySha256
  )
    fail(
      "Only the verified already-restored baseline copy may finish extension initialization",
    );
  return verifyRestoredCopy(
    database,
    backup,
    restoreSecuritySnapshot(backup),
    true,
  );
}

export function realtimeRoleRestoreSql(value: unknown): string {
  const role = object(value);
  if (
    [
      "login",
      "superuser",
      "createDb",
      "createRole",
      "inherit",
      "bypassRls",
      "replication",
    ].some((key) => role[key] !== false) ||
    role.connectionLimit !== -1 ||
    role.validUntil !== null ||
    JSON.stringify(role.config) !==
      JSON.stringify(["search_path=public, extensions, realtime"]) ||
    JSON.stringify(role.memberships) !==
      JSON.stringify([
        { role: "anon", admin: false },
        { role: "authenticated", admin: false },
        { role: "service_role", admin: false },
      ])
  )
    fail("The matched Realtime ownership role has unexpected privileges");
  return `CREATE ROLE supabase_realtime_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE supabase_realtime_admin SET search_path TO public, extensions, realtime;
GRANT anon, authenticated, service_role TO supabase_realtime_admin;`;
}

export function upgradeStatements(sql: string): string[] {
  const statements = sqlStatements(sql);
  if (!statements.length || statements.some(isTransactionControl)) {
    fail("Incremental migrations must not control the enclosing transaction");
  }
  return statements.map((item) =>
    sql.slice(item.start, item.end).replace(/;+$/, "").trim(),
  );
}

export function upgradeRehearsal(): RecordValue {
  composeConfig();
  const database = inspectDatabase(false);
  if (!existsSync(`${REHEARSAL.runtime}/restore-result.json`))
    fail("Restore proof is required before an upgrade");
  const restoreProof = object(
    json(readPrivate(`${REHEARSAL.runtime}/restore-result.json`)),
  );
  if (
    restoreProof.project !== REHEARSAL.project ||
    restoreProof.permissionsVerified !== true
  )
    fail("Verified restored permissions are required before an upgrade");
  const active = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${REHEARSAL.project}`,
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  ]);
  if (active !== "db")
    fail(
      "Stop only the rehearsal application/platform writers before upgrading",
    );
  inventory(database.id);
  const directory = `${REHEARSAL.source}/packages/db/self-hosted/upgrades/supabase/migrations`;
  const files = readdirSync(directory)
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const history = json(
    psql(
      database.id,
      "SELECT coalesce(json_agg(json_build_object('version',version,'name',name,'statements',statements) ORDER BY version), '[]'::json) FROM supabase_migrations.schema_migrations;",
    ),
  );
  if (!Array.isArray(history)) fail("Invalid migration history");
  const allowed = new Set([
    "20261031154237",
    ...files.map((file) => file.slice(0, 14)),
  ]);
  if (history.some((row) => !allowed.has(String(object(row).version))))
    fail("Unexpected existing migration history");
  const pending: string[] = [];
  let missingSeen = false;
  for (const file of files) {
    const version = file.slice(0, 14),
      name = file.slice(15, -4);
    const sql = readFileSync(join(directory, file), "utf8");
    const statements = upgradeStatements(sql);
    const existing = history.map(object).find((row) => row.version === version);
    if (existing) {
      if (
        missingSeen ||
        existing.name !== name ||
        JSON.stringify(existing.statements) !== JSON.stringify(statements)
      )
        fail("Applied migration history is not the exact reviewed prefix");
      continue;
    }
    missingSeen = true;
    const encoded = statements.map(
      (statement) =>
        `convert_from(decode('${Buffer.from(statement).toString("base64")}', 'base64'), 'UTF8')`,
    );
    pending.push(
      `${sql}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${version}','${name}',ARRAY[${encoded.join(",")}]);`,
    );
  }
  if (pending.length) {
    psql(
      database.id,
      `SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';\nSELECT pg_advisory_xact_lock(174672301, 20261101);\n${pending.join("\n")}`,
      true,
      true,
    );
  }
  const report = {
    project: REHEARSAL.project,
    upgraded: pending.length,
    sourceCommit: sourceCommit(),
    inventory: inventory(database.id),
  };
  writeNew(`${REHEARSAL.runtime}/upgrade-${report.sourceCommit}.json`, report);
  return report;
}

export function parseRehearsalArguments(args: string[]): string {
  if (
    args.length !== 1 ||
    ![
      "prepare",
      "config",
      "snapshot",
      "seed-config",
      "restore",
      "repair-restore",
      "resume-partition-restore",
      "finalize-extension-restore",
      "upgrade",
      "retarget",
      "--help",
    ].includes(args[0]!)
  )
    fail(
      "Use prepare|config|snapshot|seed-config|restore|repair-restore|resume-partition-restore|finalize-extension-restore|upgrade|retarget; no arbitrary target arguments are accepted",
    );
  return args[0]!;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const mode = parseRehearsalArguments(process.argv.slice(2));
    if (mode === "--help") {
      console.log(
        "Dedicated same-host restore rehearsal. Actions: prepare, config, snapshot, seed-config, restore, repair-restore, resume-partition-restore, finalize-extension-restore, upgrade, retarget. Does not start application services, expose public ports, replace the stage or provide off-host backups.",
      );
    } else {
      if (process.geteuid?.() !== 0)
        fail("Explicit administrative execution is required");
      process.umask(0o077);
      const actions: Record<string, () => RecordValue> = {
        prepare: prepareRehearsal,
        config: composeConfig,
        snapshot: snapshotOriginal,
        "seed-config": seedRehearsalConfig,
        restore: () => restoreRehearsal(),
        "repair-restore": () => restoreRehearsal(true),
        "resume-partition-restore": () => restoreRehearsal(true, true),
        "finalize-extension-restore": finalizeMatchedExtensionRestore,
        upgrade: upgradeRehearsal,
        retarget: retargetRehearsal,
      };
      console.log(JSON.stringify(actions[mode]!(), null, 2));
    }
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Rehearsal failed; details suppressed",
    );
    process.exitCode = 1;
  }
}
