#!/usr/bin/env python3
"""Reviewed synthetic-fixture runner. Source preparation is not an apply grant."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
WORKER = HERE / "append-upgrades.mjs"
EXPECTED_WORKER_SHA = "988aa4bf63d04858f045467fcbda587b8fdf85684b3a60c11b2beca5fd9a87bc"
PRIVATE_ENV = Path("/home/sergey/Work/Reports/agsaas-completion-20261103/private/database.env")
REPORTS = Path("/home/sergey/Work/Reports/agsaas-completion-20261103")
NODE = "/opt/imon-runtime/node/bin/node"


class Refusal(Exception):
    pass


def queue_unit():
    if os.getuid() != 1000 or os.geteuid() != 1000:
        raise Refusal("ordinary-uid-1000-required")
    match = re.search(
        r"(?:^|/)(imon-job@([0-9]{8}T[0-9]{6}-[a-f0-9]{10})\.service)(?:/|$)",
        Path("/proc/self/cgroup").read_text(), re.MULTILINE,
    )
    if not match:
        raise Refusal("shared-imon-job-cgroup-required")
    return match.group(1), match.group(2)


def database_url():
    fd = os.open(PRIVATE_ENV, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384:
            raise Refusal("owned-mode-0600-private-database-env-required")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
            source = stream.read()
    finally:
        os.close(fd)
    values = {}
    for line in source.splitlines():
        tokens = shlex.split(line, comments=True, posix=True)
        if not tokens:
            continue
        if tokens[0] == "export":
            tokens = tokens[1:]
        if len(tokens) != 1 or "=" not in tokens[0]:
            raise Refusal("private-env-must-contain-literal-assignment-only")
        key, value = tokens[0].split("=", 1)
        if key != "TEST_DATABASE_URL" or key in values or not value or "\x00" in value:
            raise Refusal("private-env-must-contain-one-test-database-url")
        values[key] = value
    if set(values) != {"TEST_DATABASE_URL"}:
        raise Refusal("private-test-database-url-missing")
    return values["TEST_DATABASE_URL"]


def save_result(path, result):
    data = (json.dumps(result, indent=2, ensure_ascii=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["inspect", "rehearse", "commit"])
    parser.add_argument("--catalog-sha256")
    parser.add_argument("--rehearsal")
    args = parser.parse_args()
    unit, job_id = queue_unit()
    if args.mode == "inspect":
        if args.catalog_sha256 or args.rehearsal:
            raise Refusal("inspect-does-not-accept-write-inputs")
    elif not re.fullmatch(r"[a-f0-9]{64}", args.catalog_sha256 or ""):
        raise Refusal("exact-inspect-catalog-sha256-required")
    if (args.mode == "commit") != bool(args.rehearsal):
        raise Refusal("commit-requires-its-exact-successful-rehearsal-receipt")
    if hashlib.sha256(WORKER.read_bytes()).hexdigest() != EXPECTED_WORKER_SHA:
        raise Refusal("reviewed-worker-source-changed")
    launcher_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    output = REPORTS / f"synthetic-append-upgrades-{args.mode}-{job_id}"
    output.mkdir(mode=0o700, exist_ok=False)
    # Do not inherit provider credentials, DATABASE_URL, PG*, NODE_OPTIONS,
    # shell initialization or dotenv files. There is no shell evaluation.
    env = {
        "PATH": "/opt/imon-runtime/node/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8", "NODE_ENV": "test",
        "TEST_DATABASE_URL": database_url(),
        "AGSAAS_SYNTHETIC_UPGRADE_LAUNCHER_SHA256": launcher_sha,
    }
    try:
        completed = subprocess.run(
            [NODE, str(WORKER), args.mode, args.catalog_sha256 or "-", args.rehearsal or "-"],
            cwd=HERE, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240, check=False,
        )
        try:
            result = json.loads(completed.stdout)
            if not isinstance(result, dict) or result.get("kind") != "agsaas-synthetic-upgrades-v1":
                raise ValueError("unrecognized result")
        except (ValueError, UnicodeError):
            result = {"status": "runner-output-unrecognized-inspect-provenance", "mode": args.mode, "queueUnit": unit}
        code = completed.returncode
        if result.get("status") in ("runner-output-unrecognized-inspect-provenance", "failed"):
            code = code or 1
        # Driver stderr is never persisted or echoed. The worker emits only
        # bounded refusal codes/SQLSTATE, without error text or credentials.
    except subprocess.TimeoutExpired:
        result = {"status": "execution-interrupted-outcome-unknown-inspect-provenance", "mode": args.mode, "queueUnit": unit}
        code = 124
    save_result(output / "result.json", result)
    print(json.dumps({"resultFile": str(output / "result.json"), "status": result.get("status"), "exitCode": code}))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refusal as error:
        print(json.dumps({"status": "refused-before-worker", "reason": str(error)}))
        sys.exit(1)
    except Exception:
        # No traceback may expose an environment assignment or database URL.
        print(json.dumps({"status": "preparation-or-output-failed", "detail": "Inspect the retained SQL provenance before retrying a commit"}))
        sys.exit(1)
