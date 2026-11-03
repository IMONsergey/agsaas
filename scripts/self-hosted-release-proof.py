#!/usr/bin/env python3
"""Read-only exact release/image/runtime provenance receipt, never Docker Env."""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys


def run(*args):
    result = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError("Docker provenance query failed; private output suppressed")
    return result.stdout.decode()


def compare(service, expected, labels, runtime):
    errors = []
    if labels.get("org.opencontainers.image.revision") != expected:
        errors.append("image-revision-mismatch")
    if labels.get("org.opencontainers.image.source") != "https://github.com/IMONsergey/agsaas":
        errors.append("image-source-mismatch")
    if runtime.strip() != expected:
        errors.append("runtime-revision-mismatch")
    return {"service": service, "expectedRevision": expected, "errors": errors, "passed": not errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--website", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"agsaas-[a-z0-9-]+", args.project) or not re.fullmatch(r"[a-f0-9]{40}", args.release):
        raise RuntimeError("Use the exact owned project and full source revision")
    results = []
    for service in ["api", "worker", "dashboard"] + (["website"] if args.website else []):
        ids = run("ps", "-q", "--filter", "label=com.docker.compose.project=" + args.project,
                  "--filter", "label=com.docker.compose.service=" + service).split()
        if len(ids) != 1:
            results.append({"service": service, "passed": False, "errors": ["exact-running-container-required"]})
            continue
        image = run("inspect", "--format", "{{.Image}}", ids[0]).strip()
        labels = json.loads(run("image", "inspect", "--format", "{{json .Config.Labels}}", image)) or {}
        runtime = run("exec", ids[0], "cat", "/tmp/git-sha.txt")
        value = compare(service, args.release, labels, runtime)
        value.update(imageId=image, containerId=ids[0])
        results.append(value)
    success = all(r["passed"] for r in results)
    print(json.dumps({"checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "project": args.project,
                      "release": args.release, "success": success, "services": results}, indent=2))
    return 0 if success else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Release proof failed; private details suppressed", file=sys.stderr)
        sys.exit(1)
