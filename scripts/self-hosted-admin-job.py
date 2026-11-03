#!/usr/bin/env python3
"""Bounded privileged backup adapter sharing the existing imon-job heavy slot.

It consumes the installed shared quarantine protocol, without changing ACLs,
sudo policy or NoNewPrivileges. The root
service must also impose CPU/memory/PID limits. No arbitrary command is accepted.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
LOCK = Path("/home/sergey/.local/state/imon-jobs/heavy.lock")
HEAVY_MODULE = Path("/usr/local/lib/imon/heavy_slot.py")
SCRIPT = Path(__file__).with_name("self-hosted-backup.py").resolve()
spec = importlib.util.spec_from_file_location("backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def open_slot():
    # Never create/recreate/chown the queue lock. All participants use one inode.
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    try:
        backup.ensure(stat.S_ISREG(info.st_mode) and info.st_uid == pwd.getpwnam("sergey").pw_uid
                      and info.st_nlink == 1 and (info.st_mode & 0o077) == 0,
                      "The existing shared heavy lock is unsafe")
        backup.ensure((LOCK.lstat().st_dev, LOCK.lstat().st_ino) == (info.st_dev, info.st_ino),
                      "The shared heavy lock changed identity")
    except BaseException:
        os.close(fd)
        raise
    return fd, (info.st_dev, info.st_ino)



def heavy_control():
    info = HEAVY_MODULE.lstat()
    backup.ensure(stat.S_ISREG(info.st_mode) and not HEAVY_MODULE.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022,
                  "Shared heavy-slot protocol is not safely installed")
    module_spec = importlib.util.spec_from_file_location("imon_heavy_slot", HEAVY_MODULE)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module.Control()


def record_candidate_stopped(receipt):
    manifest_path = Path("/opt/agsaas/candidate-20261103/runtime/supabase/candidate-manifest.json")
    if not manifest_path.exists():
        return  # Launch may have failed before preparation; the root quarantine is authoritative.
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        backup.ensure(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and (info.st_mode & 0o077) == 0 and info.st_size <= 262144,
                      "Unsafe candidate builder receipt")
        with os.fdopen(fd, "r", closefd=False) as handle:
            manifest = json.load(handle)
    finally:
        os.close(fd)
    builder = manifest.get("builder", {})
    backup.ensure(manifest.get("project") == "agsaas-candidate-20261103" and
                  builder.get("containerId") == receipt["builder"]["containerId"] and
                  builder.get("imageId") == receipt["builder"]["imageId"] and
                  builder.get("image") == receipt["builder"]["image"],
                  "Candidate manifest disagrees with independently verified builder")
    manifest["builderMayBeActive"] = False
    manifest["builderStoppedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    temporary = manifest_path.with_name(f"candidate-manifest.json.quiesced-{os.getpid()}")
    try:
        with temporary.open("x") as handle:
            json.dump(manifest, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, manifest_path)
        dfd = os.open(manifest_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        temporary.unlink(missing_ok=True)


def quiesce_candidate_builder(control, fd):
    return control.recover_candidate(fd, before_clear=record_candidate_stopped)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["scheduled", "snapshot", "plan", "restore", "offsite", "retrieve", "retention", "verify", "integration", "candidate"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--lock-timeout", type=int, default=3600)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--name")
    parser.add_argument("--snapshot-id")
    parser.add_argument("--boot-database", action="store_true")
    parser.add_argument("--require-offsite-capacity", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--postgres-image")
    parser.add_argument("--redis-image")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--candidate-action", choices=["launch", "prepare", "config", "platform", "bootstrap", "build", "start", "seed", "ingress", "status", "stop", "recover-builder"])
    parser.add_argument("--release")
    args = parser.parse_args()
    backup.ensure(60 <= args.timeout <= 7200 and 1 <= args.lock_timeout <= 3600, "Invalid bounded runtime")
    if args.action == "candidate":
        backup.ensure(os.geteuid() == 0 and args.candidate_action, "Candidate operation requires its deployment owner and fixed action")
        if args.candidate_action in ("launch", "prepare"):
            backup.ensure(bool(args.release and args.redis_image), "Candidate prepare/launch requires exact release and installed Redis digest")
        else:
            backup.ensure(args.release is None and args.redis_image is None, "Only candidate prepare/launch accepts release/image arguments")
        cfg = {"project": "agsaas-candidate-20261103", "runtime": "/opt/agsaas/candidate-20261103", "backupRoot": "/var/backups/agsaas"}
    elif args.action == "integration":
        backup.ensure(os.geteuid() == 0 and args.postgres_image and args.redis_image and args.receipt,
                      "Synthetic integration requires its root owner, explicit images and receipt")
        cfg = {"project": "agsaas-backup-synthetic", "runtime": "/opt/agsaas", "backupRoot": "/var/backups/agsaas"}
    else:
        backup.ensure(args.config is not None, "Select the private owned backup configuration")
        cfg = backup.load_config(args.config)
    os.umask(0o077)
    interrupted = [False]
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: interrupted.__setitem__(0, True))
    fd, identity = open_slot()
    child = None
    started = time.monotonic()
    acquired = False
    control = None
    armed = False
    try:
        while not interrupted[0] and time.monotonic() - started < args.lock_timeout:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                time.sleep(1)
        backup.ensure(acquired and not interrupted[0], "Shared heavy slot reservation timed out or was interrupted")
        status = LOCK.lstat()
        backup.ensure((status.st_dev, status.st_ino) == identity, "Shared lock identity changed")
        control = heavy_control()
        control.validate(fd, verify_queue=True)
        if args.action == "candidate" and args.candidate_action == "recover-builder":
            backup.ensure(control.blocked(), "No shared candidate quarantine requires recovery")
            print(json.dumps(quiesce_candidate_builder(control, fd)))
            return
        backup.ensure(not control.blocked(), "Shared heavy slot is quarantined; recover the exact builder before admission")
        if args.action == "candidate" and args.candidate_action in ("launch", "build"):
            quarantine = control.arm_candidate(fd)
            armed = True
            # Start only the recorded, bounded builder after durable quarantine.
            started_builder = subprocess.run(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "start", quarantine["builder"]["containerId"]], capture_output=True, timeout=60)
            backup.ensure(started_builder.returncode == 0, "Candidate builder start unconfirmed; quarantine retained until independent recovery")
        monitored = [Path(cfg["runtime"]), Path(cfg["backupRoot"])]
        for index, path in enumerate(monitored):
            while not path.exists():
                path = path.parent
            monitored[index] = path
            backup.ensure(backup.shutil.disk_usage(path).free >= backup.RESERVE, "Shared 8 GiB disk reserve breached")
        if args.action == "candidate":
            argv = ["/opt/imon-runtime/node/bin/node", "/opt/agsaas/candidate-20261103/source/scripts/self-hosted-candidate.mts", args.candidate_action]
            if args.candidate_action in ("launch", "prepare"):
                argv += [args.release, args.redis_image]
        elif args.action == "integration":
            argv = [sys.executable, str(SCRIPT.with_name("self-hosted-backup-integration.py")),
                    "--postgres-image", args.postgres_image, "--redis-image", args.redis_image,
                    "--receipt", str(args.receipt)]
        else:
            argv = [sys.executable, str(SCRIPT), args.action, "--config", str(args.config)]
        for flag, value in (("--bundle", args.bundle), ("--name", args.name), ("--snapshot-id", args.snapshot_id)):
            if value is not None:
                argv += [flag, str(value)]
        for flag, enabled in (("--boot-database", args.boot_database), ("--require-offsite-capacity", args.require_offsite_capacity), ("--apply", args.apply)):
            if enabled:
                argv.append(flag)
        child_env = os.environ.copy()
        if armed:
            child_env["AGSAAS_HEAVY_SLOT_OPERATION"] = quarantine["operationId"]
        child = subprocess.Popen(argv, start_new_session=True, env=child_env)
        child_start = time.monotonic()
        terminate_at = None
        while child.poll() is None:
            info = LOCK.lstat()
            must_stop = interrupted[0] or time.monotonic() - child_start >= args.timeout
            must_stop = must_stop or (info.st_dev, info.st_ino) != identity
            must_stop = must_stop or any(backup.shutil.disk_usage(path).free < backup.RESERVE for path in monitored)
            if must_stop and terminate_at is None:
                os.killpg(child.pid, signal.SIGTERM)
                terminate_at = time.monotonic()
            if terminate_at is not None and time.monotonic() - terminate_at >= 180:
                os.killpg(child.pid, signal.SIGKILL)
                break
            time.sleep(1)
        return_code = child.wait(timeout=10)
        # Preserve the shared slot while resuming after even a forced child kill.
        if args.action not in ("integration", "candidate"):
            recovered = subprocess.run([sys.executable, str(SCRIPT), "resume", "--config", str(args.config)], timeout=2400)
            backup.ensure(recovered.returncode == 0, "Backup service recovery failed")
        if args.action == "candidate" and args.candidate_action in ("launch", "build"):
            quiesce_candidate_builder(control, fd)
        backup.ensure(return_code == 0 and terminate_at is None, "Bounded backup operation failed or was interrupted")
        print(json.dumps({"sharedHeavySlot": True, "project": cfg["project"], "elapsedSeconds": round(time.monotonic()-started, 3), "exitCode": 0}))
    finally:
        try:
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=10)
                # The independent resume watchdog is the fallback if the adapter
                # itself is killed; an active operation's project lock defers it.
                if args.action not in ("integration", "candidate"):
                    subprocess.run([sys.executable, str(SCRIPT), "resume", "--config", str(args.config)], timeout=2400)
            if armed and control is not None and control.blocked():
                quiesce_candidate_builder(control, fd)
        finally:
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, backup.Failure) else "Privileged backup adapter failed; private details suppressed", file=sys.stderr)
        sys.exit(1)
