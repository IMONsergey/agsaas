#!/usr/bin/env python3
"""Cold, application-consistent recovery bundles for one owned Compose project.

No implicit deployment, remote initialization, secret output or destructive restore.
The default command is a read-only plan. Mutations require an explicit command.
Only immutable image IDs are used for recovery. Do not describe this as zero-downtime.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Any

FORMAT = "agsaas-cold-backup-v1"
RESERVE = 8 * 1024**3
DOCKER = ["docker", "--host", "unix:///var/run/docker.sock"]
SSH_CONFIG = "/etc/imon-offsite/ssh_config"
OFFSITE_REPOSITORY = "sftp:imon-backup-relay:/data/restic"
OFFSITE_HOST = "imon-workstation"
REQUIRED_SECRETS = (
    "POSTGRES_PASSWORD", "JWT_SECRET", "JWT_KEYS", "MIDDAY_ENCRYPTION_KEY",
    "FILE_KEY_SECRET", "INVOICE_JWT_SECRET", "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    "SUPABASE_SECRET_KEY", "REDIS_QUEUE_PASSWORD",
)
STOP_PRIORITY = {
    "api-gw": 0, "dashboard": 1, "website": 1, "studio": 1, "api": 2,
    "functions": 3, "auth": 3, "rest": 3, "storage": 3, "meta": 3,
    "worker": 4, "realtime": 5, "imgproxy": 5, "supavisor": 6,
    "redis-cache": 7, "redis-queue": 7, "db": 8,
}
START_PRIORITY = {
    "db": 0, "redis-cache": 0, "redis-queue": 0, "auth": 1, "rest": 1,
    "supavisor": 1, "realtime": 1, "meta": 1, "imgproxy": 1, "storage": 2,
    "functions": 2, "api-gw": 3, "api": 4, "worker": 5,
    "dashboard": 6, "website": 6, "studio": 6,
}


class Failure(RuntimeError):
    """Only fixed, non-secret messages may reach stdout/stderr."""


def ensure(value: Any, message: str) -> None:
    if not value:
        raise Failure(message)


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    descriptor, filename = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        parent = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temporary.unlink(missing_ok=True)


def command(args: list[str], *, data: bytes | None = None,
            output: Any = subprocess.PIPE, timeout: int = 120,
            env: dict[str, str] | None = None) -> bytes:
    clean_env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG": "C", "LC_ALL": "C", "HOME": "/root",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    if env:
        clean_env.update(env)
    try:
        result = subprocess.run(args, input=data, stdout=output,
                                stderr=subprocess.PIPE, timeout=timeout, env=clean_env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Failure("Bounded subprocess failed; private details suppressed") from exc
    ensure(result.returncode == 0, "Subprocess failed; private output suppressed")
    return result.stdout or b""


def docker(*args: str, **kwargs: Any) -> bytes:
    return command(DOCKER + list(args), **kwargs)


def private_regular(path: Path, *, root: bool = True) -> None:
    info = path.lstat()
    ensure(stat.S_ISREG(info.st_mode) and not path.is_symlink()
           and path.resolve() == path and (info.st_mode & 0o077) == 0
           and (not root or info.st_uid == 0), "Unsafe private file")


def canonical_directory(path: Path, *, existing: bool = True) -> None:
    ensure(path.is_absolute() and path.resolve() == path, "Non-canonical directory")
    if existing:
        info = path.lstat()
        ensure(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
               and (info.st_mode & 0o022) == 0, "Unsafe owned directory")


def load_config(path: Path) -> dict[str, Any]:
    ensure(os.geteuid() == 0, "Use the deployment owner for backup operations")
    private_regular(path)
    cfg = json.loads(path.read_text())
    ensure(cfg.get("version") == 1, "Unsupported backup configuration")
    ensure(re.fullmatch(r"agsaas-[a-z0-9][a-z0-9-]{1,55}", cfg.get("project", "")),
           "Invalid owned Compose project")
    for name in ("runtime", "source", "backupRoot", "restoreRoot"):
        ensure(isinstance(cfg.get(name), str), "Missing owned backup path")
        value = Path(cfg[name])
        ensure(value.is_absolute() and value.resolve() == value, "Unsafe backup path")
    ensure(Path(cfg["runtime"]).is_relative_to("/opt/agsaas")
           and Path(cfg["source"]).is_relative_to("/opt/agsaas")
           and Path(cfg["restoreRoot"]).is_relative_to("/opt/agsaas/restores")
           and Path(cfg["backupRoot"]).is_relative_to("/var/backups/agsaas"),
           "Backup paths must remain in their dedicated roots")
    if cfg.get("dbAdmin", "supabase_admin") == "supabase_admin":
        ensure(cfg.get("control") == str(Path(cfg["runtime"]).parent.parent / "control"),
               "Owned TLS/deployment control state must be included")
    ensure(cfg.get("dbAdmin", "supabase_admin") in ("supabase_admin", "postgres"),
           "Unsupported database administrator")
    ensure(cfg.get("dbName", "postgres") == "postgres", "Unexpected database name")
    ensure(cfg.get("includeImages", "all") in ("all", "application", "none"),
           "Unsupported image policy")
    ensure(isinstance(cfg.get("retainLocal", 7), int) and cfg.get("retainLocal", 7) >= 2
           and isinstance(cfg.get("retainRemote", 14), int) and cfg.get("retainRemote", 14) >= 2,
           "Retain at least two verified recovery points")
    return cfg


def git(cfg: dict[str, Any], *args: str) -> bytes:
    return command(["git", "--no-optional-locks", "-c", "core.fsmonitor=false",
                    "-c", "safe.directory=" + cfg["source"], "-C", cfg["source"], *args])


def containers(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    ids = docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + cfg["project"]).decode().split()
    ensure(ids, "Owned project has no containers")
    raw = json.loads(docker("inspect", *ids))
    result = []
    services: set[str] = set()
    for item in raw:
        labels = item["Config"].get("Labels", {})
        service = labels.get("com.docker.compose.service")
        ensure(labels.get("com.docker.compose.project") == cfg["project"]
               and labels.get("com.docker.compose.project.working_dir") == cfg["runtime"]
               and service in STOP_PRIORITY and service not in services,
               "Unexpected project/service identity; no containers were changed")
        services.add(service)
        ensure(re.fullmatch(r"[a-f0-9]{64}", item["Id"]), "Invalid container identity")
        result.append({
            "id": item["Id"], "service": service, "image": item["Image"],
            "imageReference": item["Config"]["Image"],
            "running": item["State"]["Running"],
            "exitCode": item["State"].get("ExitCode"),
            "health": item["State"].get("Health", {}).get("Status"),
            "mounts": item["Mounts"],
            # Only the known PostgreSQL command is kept, never Redis arguments or Env.
            "databaseCommand": item["Config"].get("Cmd") if service == "db" else None,
        })
    ensure({"db", "redis-queue", "storage"}.issubset(services), "Incomplete core project")
    return result


def tree_size(path: Path) -> int:
    total = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            value = Path(root) / name
            info = value.lstat()
            if stat.S_ISLNK(info.st_mode):
                ensure(value.resolve().is_relative_to(path), "Backup contains an external symlink")
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
            else:
                ensure(stat.S_ISDIR(info.st_mode), "Backup contains an unsupported special file")
    return total


def inventory(cfg: dict[str, Any]) -> dict[str, Any]:
    for name in ("runtime", "source"):
        canonical_directory(Path(cfg[name]))
    ensure(not git(cfg, "status", "--porcelain", "--untracked-files=all").strip(),
           "A clean reviewed source checkout is required")
    release = git(cfg, "rev-parse", "HEAD").decode().strip()
    ensure(re.fullmatch(r"[a-f0-9]{40}", release), "Invalid release revision")
    private_regular(Path(cfg["runtime"]) / ".env")
    env_names = {
        match.group(1) for line in (Path(cfg["runtime"]) / ".env").read_text().splitlines()
        if (match := re.match(r"^([A-Z][A-Z0-9_]*)=(.+)$", line))
        and match.group(2).strip() not in ("", '""', "''")
    }
    if cfg.get("dbAdmin", "supabase_admin") == "supabase_admin":
        ensure(set(REQUIRED_SECRETS).issubset(env_names), "Required durable key inventory is incomplete")
    current = containers(cfg)
    ensure(next(c for c in current if c["service"] == "db")["databaseCommand"] in (
        ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"],
        ["postgres"]), "Unexpected PostgreSQL command")
    ensure(all(not c["running"] or c["health"] in (None, "healthy") for c in current),
           "Snapshot requires healthy services or deliberately stopped services")
    ensure(next(c for c in current if c["service"] == "db")["running"],
           "Database must run for pre-snapshot verification")
    roots = [{"name": "runtime", "path": cfg["runtime"]}]
    if cfg.get("control"):
        canonical_directory(Path(cfg["control"]))
        roots.append({"name": "control", "path": cfg["control"]})
    volumes: dict[str, dict[str, str]] = {}
    for c in current:
        for mount in c["mounts"]:
            if mount["Type"] == "bind":
                ensure(Path(mount["Source"]).is_relative_to(cfg["runtime"]),
                       "Unowned bind mount blocks snapshot")
                ensure(Path(mount["Source"]).resolve() == Path(mount["Source"]),
                       "Non-canonical bind mount blocks snapshot")
            elif mount["Type"] == "volume":
                if c["service"] in ("redis-cache",) or mount["Destination"] == "/root/.cache/deno":
                    continue  # Re-creatable caches, explicitly excluded from durable state.
                name = mount.get("Name", "")
                ensure(name.startswith(cfg["project"] + "_"), "Unowned durable volume")
                short = name[len(cfg["project"]) + 1:]
                ensure(short in ("db-config", "redis-queue-data"), "Unexpected durable volume")
                info = json.loads(docker("volume", "inspect", name))[0]
                ensure(info["Driver"] == "local" and not info.get("Options")
                       and info.get("Labels", {}).get("com.docker.compose.project") == cfg["project"],
                       "Durable volume aliases an unowned filesystem")
                volumes[short] = {"name": short, "path": info["Mountpoint"]}
            else:
                raise Failure("Unsupported mount type")
    ensure({"db-config", "redis-queue-data"}.issubset(volumes), "Missing durable volumes")
    roots.extend(volumes[k] for k in sorted(volumes))
    key = Path(volumes["db-config"]["path"]) / "pgsodium_root.key"
    if cfg.get("dbAdmin", "supabase_admin") == "supabase_admin":
        ensure(key.is_file() and not key.is_symlink() and key.stat().st_size > 0,
               "Missing pgsodium root key")
    for root in roots:
        root["estimatedBytes"] = tree_size(Path(root["path"]))
    image_policy = cfg.get("includeImages", "all")
    selected = sorted({c["image"] for c in current if image_policy == "all"
                       or image_policy == "application" and c["service"] in ("api", "worker", "dashboard", "website")})
    image_data = json.loads(docker("image", "inspect", *sorted({c["image"] for c in current})))
    images = [{"id": i["Id"], "bytes": i["Size"], "repoDigests": i.get("RepoDigests", []),
               "included": i["Id"] in selected} for i in image_data]
    source_bytes = 0
    for raw in git(cfg, "ls-files", "-z").split(b"\0"):
        if raw:
            relative = Path(os.fsdecode(raw))
            ensure(not relative.is_absolute() and ".." not in relative.parts, "Unsafe tracked source path")
            source_bytes += (Path(cfg["source"]) / relative).lstat().st_size + 1024
    estimated = source_bytes + sum(r["estimatedBytes"] for r in roots) + sum(i["bytes"] for i in images if i["included"])
    return {
        "format": FORMAT, "createdAt": utc(), "project": cfg["project"], "release": release,
        "runtime": cfg["runtime"], "source": cfg["source"], "roots": roots,
        "containers": current, "images": images, "selectedImages": selected,
        "imagePolicy": image_policy, "estimatedUncompressedBytes": estimated,
        "estimatedSourceBytes": source_bytes,
        "completeImageSet": image_policy == "all",
        "durableKeyNamesPresent": sorted(set(REQUIRED_SECRETS) & env_names),
        "pgsodiumKeySha256": sha256(key) if key.is_file() else None,
        "stopOrder": [c["service"] for c in sorted(current, key=lambda c: STOP_PRIORITY[c["service"]]) if c["running"]],
        "startOrder": [c["service"] for c in sorted(current, key=lambda c: START_PRIORITY[c["service"]]) if c["running"]],
        "requiresMaintenanceWindow": True,
    }


def capacity_required(payload_bytes: int) -> int:
    ensure(payload_bytes >= 0, "Invalid payload size")
    return math.ceil(payload_bytes * 1.15) + RESERVE


def offsite_capacity(payload_bytes: int) -> dict[str, Any]:
    result = command(["sftp", "-F", SSH_CONFIG, "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
                      "-oUpdateHostKeys=no", "-oConnectTimeout=10", "-b", "-", "imon-backup-relay"],
                     data=b"df /data\n", timeout=25).decode()
    row = next((line.split() for line in result.splitlines() if re.match(r"^\s*\d+\s+\d+\s+\d+", line)), None)
    ensure(row is not None and len(row) >= 3, "Offsite capacity response is invalid")
    available = int(row[2]) * 1024
    required = capacity_required(payload_bytes)
    return {"checkedAt": utc(), "availableBytes": available, "requiredBytes": required,
            "reserveBytes": RESERVE, "payloadBytes": payload_bytes, "fits": available >= required}


@contextlib.contextmanager
def operation_lock(cfg: dict[str, Any], *, if_idle: bool = False):
    path = Path("/run/lock") / (cfg["project"] + "-backup.lock")
    with path.open("a") as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            if if_idle:
                yield False
                return
            raise Failure("Another project backup/restore operation is active") from exc
        yield True


def wait_running(container_id: str, deadline: float) -> None:
    while time.monotonic() < deadline:
        info = json.loads(docker("inspect", "--format", "{{json .State}}", container_id))
        if info["Running"] and info.get("Health", {}).get("Status", "healthy") == "healthy":
            return
        if not info["Running"] or info.get("Health", {}).get("Status") == "unhealthy":
            raise Failure("A previously running service did not recover")
        time.sleep(1)
    raise Failure("Service readiness deadline exceeded")


def resume(cfg: dict[str, Any], journal: dict[str, Any]) -> None:
    ensure(journal.get("project") == cfg["project"], "Resume journal project mismatch")
    current = {c["id"]: c for c in containers(cfg)}
    originals = journal["containers"]
    ensure(set(current) == {c["id"] for c in originals},
           "Project changed during backup; explicit recovery coordination is required")
    errors = []
    for original in sorted(originals, key=lambda c: START_PRIORITY[c["service"]]):
        if not original["running"]:
            continue
        try:
            if not current[original["id"]]["running"]:
                docker("start", original["id"], timeout=75)
            wait_running(original["id"], time.monotonic() + 120)
        except Failure:
            errors.append(original["service"])
    ensure(not errors, "Some previously running services require recovery; inspect private status")


def create_tar(source: Path, destination: Path) -> None:
    # Physical files retain numeric uid/gid/modes; tar is never allowed to follow symlinks.
    with destination.open("xb") as output:
        os.chmod(destination, 0o600)
        command(["tar", "--numeric-owner", "--one-file-system", "-czf", "-", "-C", str(source), "."],
                output=output, timeout=1200)


def snapshot(cfg: dict[str, Any], *, require_offsite: bool) -> dict[str, Any]:
    plan = inventory(cfg)
    root = Path(cfg["backupRoot"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    canonical_directory(root)
    ensure(shutil.disk_usage(root).free >= capacity_required(plan["estimatedUncompressedBytes"] * 2),
           "Insufficient local backup and recovery workspace")
    if require_offsite:
        capacity = offsite_capacity(plan["estimatedUncompressedBytes"])
        ensure(capacity["fits"], "Offsite capacity is below payload budget plus 8 GiB; no services changed")
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + plan["release"][:12]
    destination = root / (name + ".partial")
    destination.mkdir(mode=0o700)
    journal_path = root / "active-operation.json"
    ensure(not journal_path.exists() or json.loads(journal_path.read_text()).get("resumed") is True,
           "A previous backup journal requires resume before another snapshot")
    journal = {"project": cfg["project"], "startedAt": utc(), "containers": plan["containers"], "resumed": False}
    # Slow immutable exports happen while services still run.
    with (destination / "source.tar").open("xb") as output:
        command(["git", "-c", "safe.directory=" + cfg["source"], "-C", cfg["source"],
                 "archive", "--format=tar", plan["release"]], output=output, timeout=300)
    if plan["selectedImages"]:
        raw = destination / "images.tar"
        with raw.open("xb") as output:
            docker("image", "save", *plan["selectedImages"], output=output, timeout=1800)
        with raw.open("rb") as source, (destination / "images.tar.gz").open("xb") as output:
            with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, compresslevel=3) as compressed:
                shutil.copyfileobj(source, compressed, 1024 * 1024)
        raw.unlink()
    atomic_json(journal_path, journal)
    stopped_at = utc()
    try:
        for item in sorted(plan["containers"], key=lambda c: STOP_PRIORITY[c["service"]]):
            if item["running"]:
                docker("stop", "--time", "60", item["id"], timeout=90)
        after = containers(cfg)
        ensure(all(not c["running"] for c in after), "All project writers must stop before copying state")
        ensure(all(c["exitCode"] == 0 for c in after if c["service"] in ("db", "redis-queue")),
               "Durable services did not stop cleanly; no cold snapshot is accepted")
        ensure({c["id"] for c in after} == {c["id"] for c in plan["containers"]},
               "Project changed during quiescence")
        for entry in plan["roots"]:
            create_tar(Path(entry["path"]), destination / (entry["name"] + ".tar.gz"))
    finally:
        # This executes after archive errors, subprocess timeouts and TERM/INT.
        # The systemd ExecStopPost resume action covers a killed Python process.
        resume(cfg, journal)
        journal["resumed"] = True
        journal["resumedAt"] = utc()
        atomic_json(journal_path, journal)
    plan["stoppedAt"] = stopped_at
    plan["resumedAt"] = journal["resumedAt"]
    plan["files"] = [{"name": f.name, "bytes": f.stat().st_size, "sha256": sha256(f)}
                     for f in sorted(destination.iterdir()) if f.is_file()]
    plan["recoveryContract"] = "Physical PostgreSQL restore requires exact saved image and architecture; network-isolated verification precedes any publication."
    atomic_json(destination / "manifest.json", plan)
    final = root / name
    destination.rename(final)
    return {"snapshot": str(final), "manifestSha256": sha256(final / "manifest.json"),
            "project": cfg["project"], "release": plan["release"], "files": len(plan["files"]),
            "payloadBytes": sum(f["bytes"] for f in plan["files"]),
            "completeImageSet": plan["completeImageSet"], "servicesResumed": True,
            "stoppedAt": stopped_at, "resumedAt": journal["resumedAt"], "offsiteVerified": False}


def checked_bundle(cfg: dict[str, Any], path: Path) -> dict[str, Any]:
    canonical_directory(path)
    ensure(path.parent == Path(cfg["backupRoot"]) and re.fullmatch(r"\d{8}T\d{6}-[a-f0-9]{12}", path.name),
           "Bundle must be a completed owned recovery point")
    private_regular(path / "manifest.json")
    manifest = json.loads((path / "manifest.json").read_text())
    ensure(manifest.get("format") == FORMAT and manifest.get("project") == cfg["project"],
           "Recovery manifest identity mismatch")
    expected = {"manifest.json"}
    for item in manifest["files"]:
        ensure(item["name"] in {"source.tar", "images.tar.gz", "runtime.tar.gz", "control.tar.gz", "db-config.tar.gz", "redis-queue-data.tar.gz"},
               "Unexpected recovery artifact")
        ensure(item["name"] not in expected, "Duplicate recovery artifact")
        expected.add(item["name"])
        file = path / item["name"]
        private_regular(file)
        ensure(file.stat().st_size == item["bytes"] and sha256(file) == item["sha256"],
               "Recovery artifact checksum mismatch")
    ensure({"source.tar", "runtime.tar.gz", "db-config.tar.gz", "redis-queue-data.tar.gz"}.issubset(expected),
           "Recovery point is incomplete")
    ensure(not any(r["name"] == "control" for r in manifest["roots"]) or "control.tar.gz" in expected,
           "Owned TLS/deployment control archive is missing")
    ensure({p.name for p in path.iterdir()} == expected, "Unexpected files in recovery point")
    return manifest


def safe_extract(archive: Path, target: Path) -> None:
    ensure(not target.exists(), "Restore target must not exist")
    # Validate every path/link first. No files are written if any member is unsafe.
    with tarfile.open(archive, "r:*") as source:
        members = source.getmembers()
        names: set[str] = set()
        symlinks: set[PurePosixPath] = set()
        for member in members:
            path = PurePosixPath(member.name)
            ensure(not path.is_absolute() and ".." not in path.parts,
                   "Unsafe archive member path")
            ensure(member.name not in names, "Duplicate archive member")
            names.add(member.name)
            ensure(member.isfile() or member.isdir() or member.issym() or member.islnk(),
                   "Unsafe archive member type")
            if member.issym():
                linked = PurePosixPath(member.linkname)
                ensure(not linked.is_absolute(), "Unsafe archive symlink")
                # Certbot live links use ../../archive within the same owned
                # root. Normalize against the member parent, never the host.
                resolved = list(path.parent.parts)
                for part in linked.parts:
                    if part == "..":
                        ensure(resolved, "Unsafe archive symlink")
                        resolved.pop()
                    elif part != ".":
                        resolved.append(part)
                symlinks.add(path)
            if member.islnk():
                linked = PurePosixPath(member.linkname)
                ensure(not linked.is_absolute() and ".." not in linked.parts
                       and member.linkname in names and member.linkname != member.name,
                       "Unsafe archive hardlink")
        for member in members:
            path = PurePosixPath(member.name)
            ensure(not any(parent in symlinks for parent in path.parents),
                   "Archive writes through a symlink")
        target.mkdir(mode=0o700, parents=False)
        # Prevalidation above is stricter than tar's traversal handling. Numeric
        # ownership is required for the PostgreSQL and Redis physical data files.
        source.extractall(target, members=members, numeric_owner=True)


def restore(cfg: dict[str, Any], bundle: Path, name: str, *, boot_database: bool) -> dict[str, Any]:
    manifest = checked_bundle(cfg, bundle)
    ensure(re.fullmatch(r"[a-z0-9][a-z0-9-]{3,40}", name), "Invalid isolated restore name")
    root = Path(cfg["restoreRoot"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    canonical_directory(root)
    target = root / name
    ensure(not target.exists(), "Refusing to overwrite any existing restore directory")
    ensure(shutil.disk_usage(root).free >= capacity_required(manifest["estimatedUncompressedBytes"]),
           "Insufficient isolated recovery workspace")
    target.mkdir(mode=0o700)
    for artifact, directory in (("runtime.tar.gz", "runtime"), ("db-config.tar.gz", "db-config"),
                                ("redis-queue-data.tar.gz", "redis-queue-data"), ("source.tar", "source")):
        safe_extract(bundle / artifact, target / directory)
    if (bundle / "control.tar.gz").exists():
        safe_extract(bundle / "control.tar.gz", target / "control")
    key = target / "db-config" / "pgsodium_root.key"
    ensure(manifest["pgsodiumKeySha256"] is None or sha256(key) == manifest["pgsodiumKeySha256"],
           "Restored durable database key differs")
    receipt = {"format": FORMAT, "project": cfg["project"], "snapshot": bundle.name,
               "manifestSha256": sha256(bundle / "manifest.json"), "target": str(target),
               "restoredAt": utc(), "databaseBootVerified": False,
               "publicPorts": [], "network": "none", "sourceRelease": manifest["release"]}
    if boot_database:
        db = next(c for c in manifest["containers"] if c["service"] == "db")
        ensure(re.fullmatch(r"sha256:[a-f0-9]{64}", db["image"]), "Invalid recovery image identity")
        # Loading cannot replace running containers; it only imports immutable layers.
        try:
            docker("image", "inspect", db["image"])
        except Failure:
            ensure((bundle / "images.tar.gz").exists(), "Exact database image is unavailable")
            with gzip.open(bundle / "images.tar.gz", "rb") as stream:
                # docker load accepts the archive path; no secret image metadata is printed.
                raw = target / "images.tar"
                with raw.open("xb") as output:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
            docker("image", "load", "--input", str(raw), timeout=1800)
            raw.unlink()
            docker("image", "inspect", db["image"])
        container_name = "agsaas-restore-" + name + "-db"
        ensure(not docker("ps", "-aq", "--filter", "name=^/" + container_name + "$").strip(),
               "Refusing to replace an existing restore container")
        args = ["create", "--name", container_name, "--network", "none", "--restart", "no",
                "--cpus", "2", "--memory", "3g", "--pids-limit", "256",
                "--label", "agsaas.restore=" + name, "--label", "agsaas.backup.project=" + cfg["project"],
                "--env", "PGDATA=/var/lib/postgresql/data"]
        for mount in db["mounts"]:
            if mount["Type"] == "bind":
                source = Path(mount["Source"])
                ensure(source.is_relative_to(manifest["runtime"]), "Unowned restored mount")
                local = target / "runtime" / source.relative_to(manifest["runtime"])
            elif mount["Type"] == "volume" and mount["Destination"] == "/etc/postgresql-custom":
                local = target / "db-config"
            else:
                raise Failure("Unsupported recovery database mount")
            ensure(local.exists(), "Recovery database mount is missing")
            args += ["--mount", f"type=bind,source={local},target={mount['Destination']}" +
                     ("" if mount.get("RW", True) else ",readonly")]
        db_command = db["databaseCommand"]
        ensure(db_command in (["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"], ["postgres"]),
               "Unexpected PostgreSQL startup command")
        args += [db["image"], *db_command]
        container_id = docker(*args).decode().strip()
        try:
            docker("start", container_id)
            ready = False
            for _ in range(60):
                try:
                    query = "SELECT current_setting('server_version_num'), pg_is_in_recovery(), (SELECT count(*) FROM pg_catalog.pg_namespace);"
                    output = docker("exec", "--user", "postgres", container_id, "psql", "-h", "/var/run/postgresql",
                                    "-U", cfg.get("dbAdmin", "supabase_admin"), "-d", "postgres", "-XAt", "-v", "ON_ERROR_STOP=1",
                                    "-c", query, timeout=10).decode().strip()
                    ensure(re.fullmatch(r"\d+\|f\|\d+", output), "Isolated PostgreSQL verification returned an unexpected result")
                    ready = True
                    receipt["postgresVersion"] = output.split("|")[0]
                    break
                except Failure:
                    time.sleep(1)
            ensure(ready, "Isolated PostgreSQL restore did not become ready")
            receipt["databaseBootVerified"] = True
            receipt["restoreContainer"] = container_name
        finally:
            docker("stop", "--time", "45", container_id, timeout=60)
        # Leave the stopped, explicitly labelled recovery container and files for review.
    atomic_json(target / "restore-receipt.json", receipt)
    return receipt


@contextlib.contextmanager
def restic_environment():
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if directory:
        ensure(Path(directory).is_absolute(), "Invalid systemd credential directory")
        credential = Path(directory) / "restic-pass"
        ensure(credential.is_file() and not credential.is_symlink(), "Existing offsite credential is missing")
        yield {"RESTIC_PASSWORD_FILE": str(credential), "RESTIC_CACHE_DIR": "/var/cache/imon-restic"}
        return
    # A queued root process can use the same already-authorized encrypted host
    # credential without starting an unbudgeted external systemd workload.
    encrypted = Path("/etc/credstore.encrypted/imon-restic.cred")
    private_regular(encrypted)
    with tempfile.TemporaryDirectory(prefix="agsaas-restic-", dir="/run") as temporary:
        credential = Path(temporary) / "restic-pass"
        command(["systemd-creds", "decrypt", "--name=restic-pass", str(encrypted), str(credential)])
        os.chmod(credential, 0o600)
        yield {"RESTIC_PASSWORD_FILE": str(credential), "RESTIC_CACHE_DIR": "/var/cache/imon-restic"}


def restic(*args: str, output: Any = subprocess.PIPE, timeout: int = 3600) -> bytes:
    transport = "ssh -F /etc/imon-offsite/ssh_config -oBatchMode=yes -oStrictHostKeyChecking=yes -oUpdateHostKeys=no imon-backup-relay -s sftp"
    with restic_environment() as environment:
        return command(["restic", "-r", OFFSITE_REPOSITORY, "-o", "sftp.command=" + transport, *args],
                       env=environment, output=output, timeout=timeout)


def retrieve(cfg: dict[str, Any], snapshot_id: str) -> dict[str, Any]:
    ensure(re.fullmatch(r"[a-f0-9]{8,64}", snapshot_id), "Invalid offsite snapshot identity")
    tag = "agsaas-cold-v1:" + cfg["project"]
    records = json.loads(restic("snapshots", "--json", "--host", OFFSITE_HOST, "--tag", tag, timeout=120))
    matched = [r for r in records if r["id"].startswith(snapshot_id)]
    ensure(len(matched) == 1, "Offsite recovery point is missing or ambiguous")
    record = matched[0]
    ensure(record.get("hostname") == OFFSITE_HOST and tag in record.get("tags", [])
           and len(record.get("paths", [])) == 1, "Offsite recovery identity mismatch")
    original = Path(record["paths"][0])
    ensure(original.parent == Path(cfg["backupRoot"])
           and re.fullmatch(r"\d{8}T\d{6}-[a-f0-9]{12}", original.name),
           "Offsite recovery point belongs to another path")
    root = Path(cfg["backupRoot"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    canonical_directory(root)
    ensure(not original.exists(), "Refusing to overwrite a local recovery point")
    partial = root / (original.name + ".partial")
    partial.mkdir(mode=0o700)
    with (partial / "manifest.json").open("xb") as output:
        restic("dump", record["id"], str(original / "manifest.json"), output=output)
    ensure((partial / "manifest.json").stat().st_size <= 4 * 1024**2, "Offsite manifest is unexpectedly large")
    manifest = json.loads((partial / "manifest.json").read_text())
    ensure(manifest.get("format") == FORMAT and manifest.get("project") == cfg["project"],
           "Offsite recovery manifest does not match")
    ensure(shutil.disk_usage(root).free >= capacity_required(sum(f["bytes"] for f in manifest["files"])),
           "Not enough workspace to retrieve the offsite recovery point")
    names = set()
    for item in manifest["files"]:
        ensure(item["name"] in {"source.tar", "images.tar.gz", "runtime.tar.gz", "control.tar.gz", "db-config.tar.gz", "redis-queue-data.tar.gz"}
               and item["name"] not in names, "Unexpected or duplicate offsite artifact")
        names.add(item["name"])
        with (partial / item["name"]).open("xb") as output:
            restic("dump", record["id"], str(original / item["name"]), output=output)
        ensure((partial / item["name"]).stat().st_size == item["bytes"]
               and sha256(partial / item["name"]) == item["sha256"], "Retrieved artifact checksum mismatch")
    partial.rename(original)
    checked_bundle(cfg, original)
    return {"project": cfg["project"], "snapshotId": record["id"], "snapshot": str(original),
            "fullPayloadRetrieved": True, "manifestSha256": sha256(original / "manifest.json")}


def offsite(cfg: dict[str, Any], bundle: Path) -> dict[str, Any]:
    manifest = checked_bundle(cfg, bundle)
    total = sum(f["bytes"] for f in manifest["files"]) + (bundle / "manifest.json").stat().st_size
    capacity = offsite_capacity(total)
    ensure(capacity["fits"], "Offsite capacity is below payload budget plus 8 GiB; nothing uploaded or deleted")
    tag = "agsaas-cold-v1:" + cfg["project"]
    events = restic("backup", "--json", "--host", OFFSITE_HOST, "--tag", tag, str(bundle))
    summary = next((j for line in events.decode().splitlines()
                    if (j := json.loads(line)).get("message_type") == "summary"), None)
    ensure(summary and re.fullmatch(r"[a-f0-9]{8,64}", summary.get("snapshot_id", "")), "Offsite upload did not produce a snapshot receipt")
    snapshot_id = summary["snapshot_id"]
    # Full payload retrieval is mandatory before verification/retention eligibility.
    ensure(shutil.disk_usage(bundle.parent).free >= capacity_required(total), "No local room for independent offsite payload verification")
    with tempfile.TemporaryDirectory(prefix=".offsite-verify-", dir=bundle.parent) as temporary:
        temp = Path(temporary)
        for name in ["manifest.json", *[f["name"] for f in manifest["files"]]]:
            with (temp / name).open("xb") as output:
                restic("dump", snapshot_id, str(bundle / name), output=output)
            ensure(sha256(temp / name) == sha256(bundle / name), "Downloaded offsite payload does not match the recovery point")
    receipt = {"project": cfg["project"], "snapshot": bundle.name, "snapshotId": snapshot_id,
               "manifestSha256": sha256(bundle / "manifest.json"), "verifiedAt": utc(),
               "payloadBytes": total, "fullPayloadRetrieved": True, "capacity": capacity}
    receipts = bundle.parent / "offsite-receipts.json"
    old = json.loads(receipts.read_text()) if receipts.exists() else []
    old = [r for r in old if r["snapshot"] != bundle.name] + [receipt]
    atomic_json(receipts, old)
    return receipt


def retention(cfg: dict[str, Any], *, apply: bool) -> dict[str, Any]:
    root = Path(cfg["backupRoot"])
    receipts_path = root / "offsite-receipts.json"
    ensure(receipts_path.exists(), "Retention requires independently verified offsite receipts")
    private_regular(receipts_path)
    receipts = json.loads(receipts_path.read_text())
    verified = {r["snapshot"]: r for r in receipts if r.get("project") == cfg["project"] and r.get("fullPayloadRetrieved") is True}
    candidates = sorted([p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"\d{8}T\d{6}-[a-f0-9]{12}", p.name)], reverse=True)
    remove = []
    for bundle in candidates[cfg.get("retainLocal", 7):]:
        checked_bundle(cfg, bundle)
        receipt = verified.get(bundle.name)
        if receipt and receipt["manifestSha256"] == sha256(bundle / "manifest.json"):
            remove.append(bundle)
    tag = "agsaas-cold-v1:" + cfg["project"]
    remote = json.loads(restic("snapshots", "--json", "--host", OFFSITE_HOST, "--tag", tag, timeout=120))
    known = {r["snapshotId"]: r for r in verified.values()}
    remote.sort(key=lambda s: s["time"], reverse=True)
    forget = []
    for item in remote[cfg.get("retainRemote", 14):]:
        receipt = next((r for key, r in known.items() if item["id"].startswith(key)), None)
        ensure(item.get("hostname") == OFFSITE_HOST and tag in item.get("tags", [])
               and receipt is not None
               and item.get("paths") == [str(root / receipt["snapshot"])],
               "Unknown offsite snapshot blocks retention; no foreign snapshot is deleted")
        forget.append(item["id"])
    if apply:
        # Explicit IDs only; never global prune or policy on another backup namespace.
        if forget:
            restic("forget", *forget, timeout=300)
        for bundle in remove:
            shutil.rmtree(bundle)
    return {"project": cfg["project"], "applied": apply,
            "localRemove": [p.name for p in remove], "remoteForget": forget,
            "globalPrunePerformed": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "snapshot", "scheduled", "resume", "verify", "restore", "offsite", "retrieve", "retention"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--name")
    parser.add_argument("--snapshot-id")
    parser.add_argument("--boot-database", action="store_true")
    parser.add_argument("--require-offsite-capacity", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--if-idle", action="store_true", help="Resume watchdog: defer while a real operation holds the lock")
    args = parser.parse_args()
    os.umask(0o077)
    cfg = load_config(args.config)
    # Raise on TERM/INT so the snapshot finally block resumes the original services.
    def interrupted(_signum: int, _frame: Any) -> None:
        raise Failure("Operation interrupted; recovery will resume original services")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    ensure(not args.if_idle or args.command == "resume", "Idle deferral is only valid for recovery")
    with operation_lock(cfg, if_idle=args.if_idle) as acquired:
        if not acquired:
            print(json.dumps({"project": cfg["project"], "recoveryDeferred": True}))
            return
        if args.command == "plan":
            result = inventory(cfg)
            if args.require_offsite_capacity:
                result["offsiteCapacity"] = offsite_capacity(result["estimatedUncompressedBytes"])
        elif args.command in ("snapshot", "scheduled"):
            result = snapshot(cfg, require_offsite=args.require_offsite_capacity)
            if args.command == "scheduled":
                status = {"project": cfg["project"], "checkedAt": utc(), "local": result,
                          "offsiteVerified": False}
                try:
                    status["offsite"] = offsite(cfg, Path(result["snapshot"]))
                    status["offsiteVerified"] = True
                    status["retention"] = retention(cfg, apply=True)
                finally:
                    atomic_json(Path(cfg["backupRoot"]) / "scheduled-status.json", status)
                result = status
        elif args.command == "resume":
            journal = Path(cfg["backupRoot"]) / "active-operation.json"
            if journal.exists():
                private_regular(journal)
                data = json.loads(journal.read_text())
                if not data.get("resumed"):
                    resume(cfg, data)
                    data.update(resumed=True, resumedAt=utc())
                    atomic_json(journal, data)
            result = {"project": cfg["project"], "resumed": True}
        elif args.command == "retention":
            result = retention(cfg, apply=args.apply)
        elif args.command == "retrieve":
            ensure(args.snapshot_id is not None, "Select an offsite recovery point")
            result = retrieve(cfg, args.snapshot_id)
        else:
            ensure(args.bundle is not None, "Select an owned bundle")
            if args.command == "verify":
                manifest = checked_bundle(cfg, args.bundle)
                result = {"project": cfg["project"], "verified": True, "release": manifest["release"],
                          "completeImageSet": manifest["completeImageSet"]}
            elif args.command == "restore":
                ensure(args.name is not None, "Name the new isolated restore")
                result = restore(cfg, args.bundle, args.name, boot_database=args.boot_database)
            else:
                result = offsite(cfg, args.bundle)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Backup operation failed; private details suppressed", file=sys.stderr)
        sys.exit(1)
