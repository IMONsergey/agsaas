#!/usr/bin/env python3
"""Bounded real Docker recovery test. Creates ONLY synthetic, network-none fixtures.

Run through self-hosted-admin-job.py integration (the same shared heavy lock).
No image pulls, public binds, live stack
reads, production mutations or offsite uploads. Requires two already installed
immutable images: PostgreSQL (official layout) and Redis.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import time
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("self-hosted-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    backup.ensure(os.geteuid() == 0, "Integration fixture requires its deployment owner")
    backup.ensure(args.receipt.is_absolute() and args.receipt.parent.resolve().is_relative_to("/home/sergey/Work/Reports")
                  and not args.receipt.exists(), "Use a new private report receipt path")
    for image in (args.postgres_image, args.redis_image):
        backup.ensure(backup.re.fullmatch(r"sha256:[a-f0-9]{64}", image), "Use installed immutable image IDs")
        backup.docker("image", "inspect", image)
    os.umask(0o077)
    suffix = time.strftime("%Y%m%d%H%M%S", time.gmtime()) + "-" + secrets.token_hex(3)
    project = "agsaas-backup-regression-" + suffix
    root = Path("/opt/agsaas") / project
    root.mkdir(mode=0o700)
    runtime = root / "runtime"
    source = root / "source"
    runtime.mkdir(mode=0o700)
    source.mkdir(mode=0o700)
    (source / "README.md").write_text("Synthetic backup/restore regression fixture.\n")
    backup.command(["git", "-C", str(source), "init", "-q"])
    backup.command(["git", "-C", str(source), "add", "README.md"])
    backup.command(["git", "-C", str(source), "-c", "user.name=AGSaaS fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"])
    (runtime / ".env").write_text("POSTGRES_PASSWORD=" + secrets.token_hex(24) + "\n")
    (runtime / ".env").chmod(0o600)
    storage = runtime / "volumes" / "storage"
    storage.mkdir(parents=True)
    document = storage / "fixture.bin"
    document.write_bytes(b"SYNTHETIC-AGSaaS-RECOVERY\x00" * 100)
    data = runtime / "volumes" / "db" / "data"
    data.mkdir(parents=True)
    cfg = {"version": 1, "project": project, "runtime": str(runtime), "source": str(source),
           "backupRoot": "/var/backups/agsaas/" + project, "restoreRoot": "/opt/agsaas/restores",
           "dbAdmin": "postgres", "dbName": "postgres", "includeImages": "none", "retainLocal": 2, "retainRemote": 2}
    backup.atomic_json(root / "backup.json", cfg)
    backup.load_config(root / "backup.json")
    created = []
    volumes = []
    restore_name = "regression-" + suffix
    restore_db = "agsaas-restore-" + restore_name + "-db"
    restore_redis = "agsaas-restore-" + restore_name + "-redis"
    checks = []

    def record(name, value):
        backup.ensure(value, "Synthetic recovery assertion failed: " + name)
        checks.append({"check": name, "passed": True})

    def run(service, image, extra, command):
        name = project + "-" + service
        argv = ["run", "-d", "--name", name, "--network", "none", "--restart", "no",
                "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
                "--label", "com.docker.compose.project=" + project,
                "--label", "com.docker.compose.project.working_dir=" + str(runtime),
                "--label", "com.docker.compose.service=" + service]
        value = backup.docker(*argv, *extra, image, *command).decode().strip()
        created.append(value)
        return value

    def pg(container, query):
        return backup.docker("exec", "--user", "postgres", container, "psql", "-h", "/var/run/postgresql",
                             "-U", "postgres", "-d", "postgres", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query).decode().strip()

    result = {"project": project, "startedAt": backup.utc(), "checks": checks, "productionTouched": False, "success": False,
              "network": "none", "publicPorts": [], "offsiteTouched": False}
    args.receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup.atomic_json(args.receipt, result)
    def interrupted(_signum, _frame):
        raise backup.Failure("Synthetic integration interrupted; cleaning only its owned fixtures")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        mounts = {}
        for short in ("db-config", "redis-queue-data"):
            name = project + "_" + short
            backup.docker("volume", "create", "--label", "com.docker.compose.project=" + project,
                          "--label", "com.docker.compose.volume=" + short, name)
            volumes.append(name)
            mounts[short] = json.loads(backup.docker("volume", "inspect", name))[0]["Mountpoint"]
        key = Path(mounts["db-config"]) / "pgsodium_root.key"
        key.write_bytes(secrets.token_bytes(32))
        key.chmod(0o600)
        db = run("db", args.postgres_image,
                 ["--env-file", str(runtime / ".env"), "--mount", f"type=bind,source={data},target=/var/lib/postgresql/data",
                  "--mount", "type=volume,source=" + volumes[0] + ",target=/etc/postgresql-custom",
                  "--health-cmd", "pg_isready -U postgres -d postgres", "--health-interval", "1s",
                  "--health-timeout", "3s", "--health-retries", "30"], ["postgres"])
        redis = run("redis-queue", args.redis_image,
                    ["--mount", "type=volume,source=" + volumes[1] + ",target=/data",
                     "--health-cmd", "redis-cli ping", "--health-interval", "1s"],
                    ["redis-server", "--appendonly", "yes", "--appendfsync", "always"])
        run("storage", args.redis_image,
            # This installed image declares VOLUME /data. Bind it explicitly so
            # Docker cannot create an anonymous volume outside the fixture.
            ["--mount", f"type=bind,source={storage},target=/data", "--entrypoint", "sh"],
            ["-c", "exec sleep 3600"])
        for identifier in created:
            backup.wait_running(identifier, time.monotonic() + 90)
        pg(db, "CREATE TABLE public.recovery_fixture(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO public.recovery_fixture VALUES(1,'synthetic-recovery-value');")
        backup.docker("exec", redis, "redis-cli", "SET", "agsaas:backup:fixture", "synthetic-queue-value")
        plan = backup.inventory(cfg)
        record("bounded-owned-inventory", len(plan["containers"]) == 3 and not plan["completeImageSet"])
        snap = backup.snapshot(cfg, require_offsite=False)
        bundle = Path(snap["snapshot"])
        record("snapshot-resumed-original-services", snap["servicesResumed"] and all(c["running"] for c in backup.containers(cfg)))
        record("original-database-preserved", pg(db, "SELECT value FROM public.recovery_fixture WHERE id=1") == "synthetic-recovery-value")
        backup.checked_bundle(cfg, bundle)
        restored = backup.restore(cfg, bundle, restore_name, boot_database=True)
        record("physical-database-boot", restored["databaseBootVerified"])
        restore_root = Path(restored["target"])
        record("storage-bytes-preserved", backup.sha256(restore_root / "runtime" / "volumes" / "storage" / "fixture.bin") == backup.sha256(document))
        record("durable-key-preserved", backup.sha256(restore_root / "db-config" / "pgsodium_root.key") == backup.sha256(key))
        backup.docker("start", restore_db)
        for _ in range(60):
            try:
                value = pg(restore_db, "SELECT value FROM public.recovery_fixture WHERE id=1")
                break
            except backup.Failure:
                time.sleep(1)
        else:
            raise backup.Failure("Restored fixture query timed out")
        record("restored-row-survives-cold-copy", value == "synthetic-recovery-value")
        backup.docker("stop", "--time", "30", restore_db)
        backup.docker("run", "-d", "--name", restore_redis, "--network", "none", "--restart", "no",
                      "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
                      "--label", "agsaas.restore=" + restore_name,
                      "--mount", f"type=bind,source={restore_root / 'redis-queue-data'},target=/data",
                      args.redis_image, "redis-server", "--appendonly", "yes")
        for _ in range(30):
            try:
                queue = backup.docker("exec", restore_redis, "redis-cli", "GET", "agsaas:backup:fixture").decode().strip()
                break
            except backup.Failure:
                time.sleep(1)
        else:
            raise backup.Failure("Restored queue query timed out")
        record("redis-aof-payload-preserved", queue == "synthetic-queue-value")
        backup.docker("stop", "--time", "30", restore_redis)
        for name in (restore_db, restore_redis):
            inspected = json.loads(backup.docker("inspect", name))[0]
            record(name.rsplit("-", 1)[-1] + "-isolated", inspected["HostConfig"]["NetworkMode"] == "none" and not inspected["HostConfig"].get("PortBindings"))
        with patch.object(backup, "create_tar", side_effect=backup.Failure("Synthetic archive failure")):
            try:
                # Different second ID; this test never overwrites the first bundle.
                time.sleep(1)
                backup.snapshot(cfg, require_offsite=False)
                raise AssertionError("Archive failure was ignored")
            except backup.Failure as error:
                record("archive-failure-visible", str(error) == "Synthetic archive failure")
        record("failure-finally-resumed-all-services", all(c["running"] for c in backup.containers(cfg)))
        original = (bundle / "source.tar").read_bytes()
        (bundle / "source.tar").write_bytes(original + b"tamper")
        try:
            backup.checked_bundle(cfg, bundle)
            raise AssertionError("Checksum tampering was ignored")
        except backup.Failure:
            checks.append({"check": "tampered-bundle-rejected", "passed": True})
        finally:
            (bundle / "source.tar").write_bytes(original)
        try:
            backup.restore(cfg, bundle, restore_name, boot_database=False)
            raise AssertionError("Existing recovery directory was overwritten")
        except backup.Failure as error:
            record("existing-restore-refused", "overwrite" in str(error))
        result.update(snapshot=str(bundle), restore=restored, completedAt=backup.utc(), success=True)
    except backup.Failure as error:
        result.update(completedAt=backup.utc(), failure=str(error))
        raise
    finally:
        # Remove only objects this invocation created; never inspect or mutate a live project.
        for name in (restore_db, restore_redis):
            try:
                ids = backup.docker("ps", "-aq", "--filter", "name=^/" + name + "$").decode().split()
                for identifier in ids:
                    info = json.loads(backup.docker("inspect", identifier))[0]
                    if info["Config"].get("Labels", {}).get("agsaas.restore") == restore_name:
                        backup.docker("rm", "-f", identifier)
            except backup.Failure:
                pass
        for identifier in reversed(created):
            backup.docker("rm", "-f", identifier)
        for volume in volumes:
            backup.docker("volume", "rm", volume)
        args.receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup.atomic_json(args.receipt, result)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, backup.Failure) else "Synthetic backup integration failed; private details suppressed", file=backup.sys.stderr)
        backup.sys.exit(1)
